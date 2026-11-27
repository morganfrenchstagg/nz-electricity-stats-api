import { env } from "cloudflare:workers";
import { createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { cors } from "hono/cors";
import {
  AggregateDataPoint,
  AggregateResolution,
  DispatchAggregate,
} from "../models/dispatchAggregate";
import { Timeseries } from "../models/timeseries";
import {
  calculateLiveDailyEnergy,
  getAggregateKey,
  getMonthBounds,
  toTimeseries,
  upsertDataPoint,
} from "../services/dispatchAggregation/dispatchAggregation";
import {
  LATEST_AGGREGATED_DATE_KEY,
  LatestAggregatedDateMetadata,
} from "../sync/syncDispatchAggregates";
import { LATEST_METERED_HVDC_DATE_KEY } from "../sync/syncHvdcHistory";
import { HVDC_AGGREGATE_PREFIX } from "../services/hvdc/hvdc";
import { ONE_DAY_IN_SECONDS } from "../utilities/utilities";
import { edgeCache } from "../utilities/edgeCache";
import { createApi, json, message } from "../openapi";
import { nodeList, nzDate, timeseriesRow } from "./schemas";

// how long to cache periods still receiving data once their next day is overdue
const OVERDUE_MAX_AGE_SECONDS = 5 * 60;

// how long to cache months that include days from the live dispatch, which gets a new interval every 5 minutes
const LIVE_MAX_AGE_SECONDS = 5 * 60;

// how long to cache periods that have ended. they only change if EMI republishes a file or the metered generation
// codes change, which is rare enough to be worth a client seeing an old copy for a while
const COMPLETE_MAX_AGE_SECONDS = 30 * ONE_DAY_IN_SECONDS;

const app = createApi();
app.use(cors());

const statusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Aggregates"],
  operationId: "getAggregatesStatus",
  summary: "How far the aggregates go",
  responses: {
    200: json(
      "The latest days",
      z
        .object({
          latestDate: z
            .string()
            .nullable()
            .openapi({ format: "date", description: "The last day aggregated" }),
          latestHvdcDate: z.string().nullable().openapi({
            format: "date",
            description:
              "The last day of EMI's metered HVDC flows. The HVDC's days after it come from em6 until EMI publishes them",
          }),
        })
        .openapi("AggregatesStatus"),
    ),
  },
});

// the latest day aggregated, and the latest day of EMI's metered HVDC flows. the HVDC's days after it come from em6
// until EMI publishes their month, so they can still change until then
app.openapi(statusRoute, async (c) => {
  const [latestDate, latestHvdcDate] = await Promise.all([
    env.dispatch_kv.get(LATEST_AGGREGATED_DATE_KEY),
    env.dispatch_kv.get(LATEST_METERED_HVDC_DATE_KEY),
  ]);
  return c.json({ latestDate, latestHvdcDate }, 200);
});

const AggregateTimeseriesSchema = z
  .object({
    series: nodeList,
    data: z.array(timeseriesRow(nzDate)).openapi({
      description:
        "A row for each period: its first day, then each node's generation less load (MWh). A node with no data in a " +
        "period is 0",
      example: [["2026-10-01", -812.5, 4920.1]],
    }),
    hvdc: z
      .object({
        series: z.array(z.string().openapi({ enum: ["northFlow", "southFlow"] })),
        data: z.array(timeseriesRow(nzDate)),
      })
      .openapi({ description: "The energy the HVDC sent north and south in each period (MWh)" }),
  })
  .openapi("AggregateTimeseries");

const year = z
  .string()
  .regex(/^[0-9]{4}$/, "Invalid year, expected one like 2026")
  .openapi({ example: "2026" });

const INVALID_MONTH = "Invalid month, expected 1-12";

const month = z.coerce
  .number({ error: INVALID_MONTH })
  .int(INVALID_MONTH)
  .min(1, INVALID_MONTH)
  .max(12, INVALID_MONTH)
  .openapi({ example: 10 });

const nodesQuery = z.object({
  nodes: z.string().optional().openapi({
    description:
      "Only the nodes starting with one of these, comma separated, e.g. `HLY2201,ABY0111`. It doesn't apply to `hvdc`",
  }),
});

// what the routes for each resolution share, as they only differ in their period
const aggregateRoute = {
  method: "get" as const,
  middleware: edgeCache,
  tags: ["Aggregates"],
  responses: {
    200: json(
      "The period's data points. Periods that have ended are cached for a long time, ones with days from the live " +
        "dispatch for a few minutes",
      AggregateTimeseriesSchema,
    ),
    400: message("The year or month isn't valid"),
    404: message("Nothing has been aggregated for the period"),
  },
};

// e.g. /2026/weekly - one data point per ISO week (Monday to Sunday) in the year
const weeklyRoute = createRoute({
  ...aggregateRoute,
  path: "/{year}/weekly",
  operationId: "getWeeklyAggregates",
  summary: "Each ISO week in a year",
  description:
    "Each node's net energy in each ISO week (Monday to Sunday) of the ISO week year, so it can include the first few " +
    "days of the next year.",
  request: { params: z.object({ year }), query: nodesQuery },
});

app.openapi(weeklyRoute, async (c) => {
  return getAggregateResponse(c, "weekly", c.req.valid("param").year);
});

// e.g. /2026/monthly - one data point per month in the year
const monthlyRoute = createRoute({
  ...aggregateRoute,
  path: "/{year}/monthly",
  operationId: "getMonthlyAggregates",
  summary: "Each month in a year",
  request: { params: z.object({ year }), query: nodesQuery },
});

app.openapi(monthlyRoute, async (c) => {
  return getAggregateResponse(c, "monthly", c.req.valid("param").year);
});

// e.g. /2026/10 - one data point per day in the month
const dailyRoute = createRoute({
  ...aggregateRoute,
  path: "/{year}/{month}",
  operationId: "getDailyAggregates",
  summary: "Each day in a month",
  description:
    "Each node's net energy on each day of the month. The days EMI hasn't published yet (e.g. today so far) come from " +
    "the live dispatch.",
  request: { params: z.object({ year, month }), query: nodesQuery },
});

app.openapi(dailyRoute, async (c) => {
  const { year, month } = c.req.valid("param");
  return getAggregateResponse(c, "daily", `${year}-${String(month).padStart(2, "0")}`);
});

// /annual - one data point per year
const annualRoute = createRoute({
  ...aggregateRoute,
  path: "/annual",
  operationId: "getAnnualAggregates",
  summary: "Each year",
  description: "Each node's net energy in each year since 1997.",
  request: { query: nodesQuery },
});

app.openapi(annualRoute, async (c) => {
  return getAggregateResponse(c, "annual", "all");
});

async function getAggregateResponse(c: Context, resolution: AggregateResolution, period: string) {
  const [file, hvdcFile, { value: latestDate, metadata }, latestHvdcDate] = await Promise.all([
    env.dispatch.get(getAggregateKey(resolution, period)),
    env.dispatch.get(getAggregateKey(resolution, period, HVDC_AGGREGATE_PREFIX)),
    env.dispatch_kv.getWithMetadata<LatestAggregatedDateMetadata>(LATEST_AGGREGATED_DATE_KEY),
    env.dispatch_kv.get(LATEST_METERED_HVDC_DATE_KEY),
  ]);
  const periodEnd = getPeriodEnd(resolution, period);
  const isAggregated = resolution !== "annual" && latestDate !== null && periodEnd < latestDate;
  // the HVDC's days after EMI's latest month come from em6 until EMI publishes them, so they can still change until then
  const isComplete = isAggregated && latestHvdcDate !== null && periodEnd <= latestHvdcDate;

  let aggregate = file ? ((await file.json()) as DispatchAggregate) : null;
  let maxAgeSeconds = isComplete ? COMPLETE_MAX_AGE_SECONDS : getSecondsUntilNextDayIsDue(metadata);

  // a day's dispatch file is only published the day after, so until it's been aggregated the day comes from the
  // live dispatch instead (e.g. today so far). it's only added here rather than stored, so the aggregated day
  // replaces it as soon as it's available
  if (resolution === "daily" && !isAggregated) {
    const liveDays = await getLiveDays(period, latestDate, aggregate);
    if (liveDays.length > 0) {
      aggregate ??= { data: [] };
      for (const day of liveDays) {
        aggregate = upsertDataPoint(aggregate, day);
      }
      maxAgeSeconds = LIVE_MAX_AGE_SECONDS;
    }
  }

  if (!aggregate) {
    return c.json({ message: "No data for this period" }, 404);
  }

  // optionally filter by a comma separated list of node prefixes, e.g. ?nodes=HLY2201,ABY0111
  const nodeFilter = c.req
    .query("nodes")
    ?.split(",")
    .map((node) => node.trim())
    .filter((node) => node.length > 0);
  const timeseries = toTimeseries(aggregate, nodeFilter);
  // the MWh it sent north and south in each period
  const hvdc = hvdcFile
    ? toTimeseries((await hvdcFile.json()) as DispatchAggregate)
    : { series: [], data: [] };

  return c.json({ ...timeseries, hvdc }, 200, { "Cache-Control": `max-age=${maxAgeSeconds}` });
}

// the days in the month (e.g. 2026-10) the live dispatch has that haven't been aggregated yet
async function getLiveDays(
  month: string,
  latestDate: string | null,
  aggregate: DispatchAggregate | null,
): Promise<AggregateDataPoint[]> {
  const file = await env.dispatch.get("timeseries");
  if (!file) {
    return [];
  }

  // KV can lag behind R2 for a little while, so the aggregate file can already have a day after latestDate
  const aggregated = new Set(aggregate?.data.map((day) => day.from));

  return calculateLiveDailyEnergy((await file.json()) as Timeseries).filter(
    (day) =>
      day.from.slice(0, 7) === month &&
      (latestDate === null || day.from > latestDate) &&
      !aggregated.has(day.from),
  );
}

// a new day is aggregated about once a day (when EMI publishes the previous day's file), so periods still receiving
// data won't change until about a day after the last one was added. once that's passed it could land on any
// hourly sync, so only cache briefly until it does
function getSecondsUntilNextDayIsDue(metadata: LatestAggregatedDateMetadata | null): number {
  if (!metadata) {
    return OVERDUE_MAX_AGE_SECONDS;
  }
  const secondsSinceUpdate = Math.floor((Date.now() - metadata.updatedAt) / 1000);
  return Math.max(ONE_DAY_IN_SECONDS - secondsSinceUpdate, OVERDUE_MAX_AGE_SECONDS);
}

function getPeriodEnd(resolution: AggregateResolution, period: string): string {
  if (resolution === "daily") {
    return getMonthBounds(period).to;
  }
  // weekly files are by ISO week year, so can include up to the first few days of the following year
  return resolution === "weekly" ? `${+period + 1}-01-03` : `${period}-12-31`;
}

export default app;
