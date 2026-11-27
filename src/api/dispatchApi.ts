import { env } from "cloudflare:workers";
import { createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi, fetchCachedDataFromEmiApi } from "../clients/emiApi";
import aggregatesApi from "./aggregatesApi";
import { getSubstations } from "../clients/substations";
import { mapBySiteCode } from "../services/rtdMapping/mapBySiteCode";
import { getGenerators } from "../clients/generators";
import { mapByPointOfConnectionCode } from "../services/rtdMapping/mapByPointOfConnectionCode";
import { filterTimeseriesSince } from "../services/timeseries/timeseries";
import { getOutageListFromCache } from "../clients/pocpApi";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { getServiceUnavailableResponse, ONE_DAY_IN_SECONDS } from "../utilities/utilities";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import { getNZDateTime } from "../services/nzDateTime";
import { Timeseries } from "../models/timeseries";
import { MeteredGenerationRecord } from "../models/meteredGenerationRecord";
import { METERED_DAY_PREFIX } from "../services/meteredGeneration/meteredGeneration";
import { DISPATCH_AGGREGATES_START } from "../services/dispatchAggregation/dispatchAggregation";
import { HvdcTimeseries } from "../models/hvdc";
import { EM6_HVDC_DAY_PREFIX, HVDC_KEY } from "../sync/syncHvdc";
import { METERED_HVDC_DAY_PREFIX } from "../sync/syncHvdcHistory";
import { mergeHvdcDays } from "../services/hvdc/hvdc";
import { edgeCache } from "../utilities/edgeCache";
import { createApi, json, message } from "../openapi";
import {
  GeneratorSchema,
  HvdcTimeseriesSchema,
  nodeList,
  nullableTimeseriesRow,
  nzTime,
  SubstationSchema,
  timeseriesRow,
  UnitSchema,
} from "./schemas";

const app = createApi();
app.use(cors());

app.route("/aggregates", aggregatesApi);

const notSyncedYet = message("The dispatch hasn't been synced yet");

const nodeNames = (description: string) => z.array(z.string()).openapi({ description });

const deltaRoute = createRoute({
  method: "get",
  path: "/delta",
  tags: ["Dispatch"],
  operationId: "getDispatchDelta",
  summary: "Nodes missing from the definitions or the dispatch",
  description:
    "Compares the latest interval with `/v1/generators` and `/v1/substations`, to find units and substations that " +
    "need adding to them, or that the dispatch no longer has.",
  responses: {
    200: json(
      "What's missing",
      z
        .object({
          lastUpdated: nzTime,
          missingUnits: z.object({
            generation: z.object({
              notInDispatchList: nodeNames("Units in service that aren't in the dispatch"),
              notInGeneratorList: nodeNames("Units in the dispatch that aren't in /v1/generators"),
            }),
            substations: z.object({
              notInDispatchList: nodeNames(
                "Substations with no points of connection in the dispatch",
              ),
              notInSubstationList: nodeNames(
                "Points of connection in the dispatch whose substation isn't in /v1/substations",
              ),
            }),
          }),
        })
        .openapi("DispatchDelta"),
    ),
    503: notSyncedYet,
  },
});

app.openapi(deltaRoute, async (c) => {
  const rtdData = await fetchCachedDataFromEmiApi();
  if (!rtdData) {
    return getServiceUnavailableResponse(c, "Live dispatch data is temporarily unavailable");
  }

  const dispatchList = rtdData.map((item) => item.PointOfConnectionCode) as string[];

  const missingUnits = await checkForMissingUnits(dispatchList);

  return c.json(
    {
      lastUpdated: rtdData[0].FiveMinuteIntervalDatetime,
      missingUnits: missingUnits,
    },
    200,
  );
});

const rtdRoute = createRoute({
  method: "get",
  path: "/rtd",
  tags: ["Dispatch"],
  operationId: "getRealTimeDispatch",
  summary: "EMI's real-time dispatch, as is",
  description:
    "A proxy to EMI's real-time dispatch API, which it caches for a minute. `/v1/dispatch/recent` and " +
    "`/v1/dispatch/latest` are usually more useful.",
  responses: {
    200: json(
      "EMI's response",
      z.array(
        z
          .object({
            PointOfConnectionCode: z.string().openapi({ example: "ATI2201 ATI0" }),
            FiveMinuteIntervalDatetime: nzTime,
            SPDLoadMegawatt: z.number(),
            SPDGenerationMegawatt: z.number(),
            DollarsPerMegawattHour: z.number(),
          })
          .openapi("RealTimeDispatch"),
      ),
    ),
  },
});

app.openapi(rtdRoute, async (c) => {
  const rtd = await fetchDataFromEmiApi();
  const rtdData = await rtd.json<RealTimeDispatch[]>();
  return c.json(rtdData, 200);
});

// timestamps are NZ times, in the same format as the ones returned
const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// optionally only return the intervals after a timestamp, e.g. ?since=2026-10-14T21:55:00. clients that are up to date
// all ask for the intervals since the latest one, so the edge cache answers most polls without reading the whole
// timeseries from R2
const recentRoute = createRoute({
  method: "get",
  path: "/recent",
  middleware: [edgeCache] as const,
  tags: ["Dispatch"],
  operationId: "getRecentDispatch",
  summary: "The last 3 days' dispatch",
  description:
    "Each node's generation less load and price in each 5-minute interval over the last 3 days, from EMI's real-time " +
    "dispatch, and the HVDC's half hours over the same days. It's cached until the next interval is due.",
  request: {
    query: z.object({
      since: z
        .string()
        .regex(SINCE_FORMAT, "Invalid since, expected an NZ time like 2026-10-14T21:55:00")
        .optional()
        .openapi({
          description:
            "Only the intervals after this NZ time, e.g. the latest one a client already has. `hvdc` still has all its half hours",
          example: "2026-10-14T21:55:00",
        }),
    }),
  },
  responses: {
    200: json(
      "The intervals, empty until the first sync",
      z
        .object({
          series: nodeList,
          data: z.array(timeseriesRow(nzTime)).openapi({
            description:
              "A row for each interval: its NZ time, then each node's generation less load (MW)",
            example: [["2026-10-14T21:55:00", -21.4, 230]],
          }),
          pricing: z.array(timeseriesRow(nzTime)).openapi({
            description: "A row for each interval: its NZ time, then each node's price ($/MWh)",
            example: [["2026-10-14T21:55:00", 152.3, 141.9]],
          }),
          hvdc: HvdcTimeseriesSchema,
        })
        .openapi("RecentDispatch"),
    ),
    400: message("since isn't an NZ time like 2026-10-14T21:55:00"),
  },
});

app.openapi(recentRoute, async (c) => {
  const { since } = c.req.valid("query");

  const [timeseries, hvdcFile] = await Promise.all([
    env.dispatch.get("timeseries"),
    env.dispatch.get(HVDC_KEY),
  ]);
  // the same last few days as the dispatch, all of them even with since, as em6 publishes each half hour about half an
  // hour after it ends, by when the dispatch is well past it
  const hvdc = hvdcFile ? ((await hvdcFile.json()) as HvdcTimeseries) : { series: [], data: [] };

  if (!timeseries) {
    return c.json({ series: [], data: [], pricing: [], hvdc }, 200);
  }

  const json = (await timeseries.json()) as Timeseries;
  // based on the full timeseries, as the filtered one can be empty
  const maxAge = calculateMaxAgeHeader(json);

  return c.json(
    {
      ...(since ? filterTimeseriesSince(json, since) : json),
      hvdc,
    },
    200,
    { "Cache-Control": `max-age=${maxAge}` },
  );
});

const DEFAULT_MAX_AGE = 30;

function calculateMaxAgeHeader(timeseries: Timeseries): number {
  const latestTimestamp = timeseries.data[timeseries.data.length - 1][0];

  const latestDate = new Date(latestTimestamp);
  const nextDate = new Date(latestDate.setTime(latestDate.getTime() + 6 * 1000 * 60)); // 6 minutes later (5 min + 1)
  const now = getNZDateTime();

  const cachableTimeInSeconds = (nextDate.getTime() - now.getTime()) / 1000;
  return cachableTimeInSeconds > 0 ? cachableTimeInSeconds : DEFAULT_MAX_AGE;
}

const mw = z.number().openapi({ description: "MW" });
const price = z.number().openapi({ description: "$/MWh" });

const latestRoute = createRoute({
  method: "get",
  path: "/latest",
  tags: ["Dispatch"],
  operationId: "getLatestDispatch",
  summary: "The latest interval, by station and substation",
  description:
    "The generators and substations, with each unit's dispatch and current outages, and each substation's points of " +
    "connection, in the latest 5-minute interval.",
  responses: {
    200: json(
      "The latest interval",
      z
        .object({
          lastUpdated: nzTime,
          substations: z.array(
            SubstationSchema.extend({
              pointsOfConnection: z
                .array(
                  z.object({
                    pointOfConnectionCode: z.string().openapi({ example: "ALB0331" }),
                    load: mw,
                    generation: mw,
                    price,
                  }),
                )
                .optional()
                .openapi({ description: "Absent when the dispatch has none at the substation" }),
            }),
          ),
          generators: z.array(
            GeneratorSchema.extend({
              units: z.array(
                UnitSchema.extend({
                  dispatch: z
                    .object({ load: mw, generation: mw, price })
                    .optional()
                    .openapi({ description: "Absent when the unit isn't in the dispatch" }),
                  outages: z.array(
                    z.object({
                      outageBlock: z.string(),
                      mwLost: z.number(),
                      mwRemain: z.number(),
                      from: z.string().openapi({ format: "date-time" }),
                      until: z.string().openapi({ format: "date-time" }),
                    }),
                  ),
                }),
              ),
            }),
          ),
        })
        .openapi("LatestDispatch"),
    ),
    503: notSyncedYet,
  },
});

app.openapi(latestRoute, async (c) => {
  const [rtdData, outages, substations, generators] = await Promise.all([
    fetchCachedDataFromEmiApi(),
    getOutageListFromCache(),
    getSubstations(),
    getGenerators(),
  ]);

  if (!rtdData) {
    return getServiceUnavailableResponse(c, "Live dispatch data is temporarily unavailable");
  }

  const siteCodeMap = mapBySiteCode(rtdData);
  const pointOfConnectionCodeMap = mapByPointOfConnectionCode(rtdData);

  return c.json(
    {
      lastUpdated: rtdData[0].FiveMinuteIntervalDatetime,
      substations: substations.map((substation) => ({
        ...substation,
        pointsOfConnection: siteCodeMap.get(substation.siteId),
      })),
      generators: generators.map((generator) => ({
        ...generator,
        units: generator.units.map((unit) => ({
          ...unit,
          dispatch: pointOfConnectionCodeMap.get(unit.node),
          outages:
            outages[unit.node]?.map((o) => ({
              outageBlock: o.outageBlock,
              mwLost: o.mwattLost,
              mwRemain: o.mwattRemaining,
              from: o.timeStart,
              until: o.timeEnd,
            })) || [],
        })),
      })),
    },
    200,
  );
});

// a day's dispatch by interval, or its metered generation and load by trading period for the days the aggregates take
// from metered data (including the first, partial, day of dispatch files). each falls back to the other, e.g. while
// the metered data is still being backfilled. the HVDC's half hours are returned with it as hvdc
const dayRoute = createRoute({
  method: "get",
  path: "/{date}",
  middleware: [edgeCache] as const,
  tags: ["Dispatch"],
  operationId: "getDayDispatch",
  summary: "A day's dispatch",
  description:
    "Each node's generation less load and price in each 5-minute interval of an NZ day, from EMI's daily dispatch " +
    "files, and the HVDC's half hours. Before 11 September 2020 (back to August 1997) it's each unit's average metered " +
    "generation and each point of connection's load in each half-hour trading period instead, without prices.",
  request: {
    params: z.object({
      date: z
        .string()
        .openapi({ description: "An NZ day, as YYYY-MM-DD or YYYYMMDD", example: "2026-10-14" }),
    }),
  },
  responses: {
    200: json(
      "The day's intervals",
      z
        .object({
          series: nodeList,
          data: z.array(timeseriesRow(nzTime)).openapi({
            description:
              "A row for each interval (or trading period, before 11 September 2020): its NZ time, then each node's " +
              "generation less load (MW)",
          }),
          pricing: z.array(nullableTimeseriesRow(nzTime)).openapi({
            description:
              "A row for each interval: its NZ time, then each node's price ($/MWh), or null where there's none (the " +
              "metered data before 11 September 2020)",
          }),
          hvdc: HvdcTimeseriesSchema,
        })
        .openapi("DayDispatch"),
    ),
    404: message("No data for this date"),
  },
});

app.openapi(dayRoute, async (c) => {
  const date = c.req.valid("param").date.replace(/-/g, "");
  const keys =
    date < DISPATCH_AGGREGATES_START.replace(/-/g, "")
      ? [METERED_DAY_PREFIX + date, `dispatch-${date}`]
      : [`dispatch-${date}`, METERED_DAY_PREFIX + date];
  const [file, hvdc] = await Promise.all([
    env.dispatch.get(keys[0]).then((file) => file ?? env.dispatch.get(keys[1])),
    getHvdcDay(date),
  ]);

  if (!file) {
    return c.json({ message: "No data for this date" }, 404);
  }

  const intervals = (await file.json()) as Record<
    string,
    (HistoricalDispatchRecord | MeteredGenerationRecord)[]
  >;
  return c.json({ ...toDayTimeseries(intervals), hvdc }, 200, {
    "Cache-Control": `max-age=${ONE_DAY_IN_SECONDS}`,
  });
});

// date is in the format 20261008
async function getHvdcDay(date: string): Promise<HvdcTimeseries> {
  const [metered, em6] = await Promise.all(
    [METERED_HVDC_DAY_PREFIX + date, EM6_HVDC_DAY_PREFIX + date].map(async (key) => {
      const file = await env.dispatch.get(key);
      return file ? ((await file.json()) as HvdcTimeseries) : null;
    }),
  );
  return mergeHvdcDays(metered, em6);
}

// the daily files leave out most nodes while they're at 0MW generation and load, so a node missing from an interval
// is 0 rather than unknown. intervals missing from the file entirely are still left out. metered data has no prices,
// so its prices are all null
function toDayTimeseries(
  intervals: Record<string, (HistoricalDispatchRecord | MeteredGenerationRecord)[]>,
): Timeseries {
  const series = [
    ...new Set(Object.values(intervals).flatMap((records) => records.map((record) => record.p))),
  ];
  const columns = new Map(series.map((node, index) => [node, index + 1]));

  const data = [] as (string | number)[][];
  const pricing = [] as (string | number | null)[][];

  for (const timestamp in intervals) {
    const dataRow: (string | number)[] = [timestamp, ...series.map(() => 0)];
    const priceRow: (string | number | null)[] = [timestamp, ...series.map(() => null)];

    for (const record of intervals[timestamp]) {
      dataRow[columns.get(record.p)!] = +record.g - +record.l;
      priceRow[columns.get(record.p)!] = "c" in record ? +record.c : null;
    }

    data.push(dataRow);
    pricing.push(priceRow);
  }

  return { series, data, pricing };
}

export default app;
