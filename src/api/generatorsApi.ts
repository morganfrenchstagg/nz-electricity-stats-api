import { env } from "cloudflare:workers";
import { createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { GeneratorDefinition, getGenerators } from "../clients/generators";
import { getOutageListFromCache, OUTAGE_DAYS_BEFORE } from "../clients/pocpApi";
import { addDays, parseNzTime, todayInNz } from "../mcp/dates";
import { PocpOutage } from "../models/pocpOutage";
import { Timeseries } from "../models/timeseries";
import {
  hoursInNzDay,
  hoursToEndOfInterval,
} from "../services/dispatchAggregation/dispatchAggregation";
import { readDispatchDay } from "../services/dispatchDay/dispatchDay";
import { getStationNodes, summariseDay } from "../services/generatorDay/generatorDay";
import { toUnitOutages } from "../services/outageMapping/outageMapper";
import {
  calculateMaxAgeHeader,
  selectNodesOnDate,
  TIMESERIES_DAYS,
} from "../services/timeseries/timeseries";
import { edgeCache } from "../utilities/edgeCache";
import {
  getServiceUnavailableResponse,
  ONE_DAY_IN_SECONDS,
  ONE_HOUR_IN_SECONDS,
} from "../utilities/utilities";
import { createApi, json, message } from "../openapi";
import {
  GeneratorSchema,
  nullableTimeseriesRow,
  nzDate,
  nzTime,
  timeseriesRow,
  UnitOutageSchema,
  UnitSchema,
} from "./schemas";

const app = createApi();
app.use(cors());

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Reference"],
  operationId: "listGenerators",
  summary: "Generating stations and their units",
  description:
    "Every station, including decommissioned ones, with each unit's node in the dispatch data, capacity and fuel.",
  responses: { 200: json("The stations", z.array(GeneratorSchema)) },
});

app.openapi(listRoute, async (c) => {
  return c.json(await getGenerators(), 200, { "Cache-Control": `max-age=${ONE_DAY_IN_SECONDS}` });
});

const mw = z.number().openapi({ description: "MW" });
const energy = z
  .number()
  .openapi({ description: "Net MWh (generation less load) over the day, or so far today" });

const GeneratorDaySchema = GeneratorSchema.extend({
  date: nzDate.openapi({ description: "The NZ day" }),
  live: z.boolean().openapi({
    description:
      "Whether it's from the live dispatch, as EMI hasn't published the day's file yet. Today always is",
  }),
  lastUpdated: nzTime.optional().openapi({
    description: "The latest interval in the live dispatch. Absent when the day isn't from it",
  }),
  summary: z
    .object({
      energy,
      peak: z
        .object({ mw, time: nzTime })
        .openapi({ description: "The interval the units' total was highest" }),
    })
    .optional()
    .openapi({
      description:
        "The station's day. Absent until today has an interval, or when none of its units have a column in `dispatch`",
    }),
  units: z.array(
    UnitSchema.extend({
      summary: z
        .object({
          energy,
          peak: z.object({ mw, time: nzTime }).openapi({
            description:
              "The interval furthest from 0, so a battery's charging node's is its most negative",
          }),
          latest: z.object({
            mw,
            price: z.number().nullable().openapi({ description: "$/MWh" }),
          }),
        })
        .optional()
        .openapi({
          description:
            "The unit's day. Absent when it has no column in `dispatch` (e.g. it's retired)",
        }),
      outages: z
        .array(UnitOutageSchema)
        .optional()
        .openapi({
          description:
            "The outages going on at any time in the day. Absent for days before the last 14, which " +
            "`/v1/outages/{date}` has",
        }),
    }),
  ),
  dispatch: z.object({
    series: z.array(z.string()).openapi({
      description:
        "The station's units, by node, in the order of each row's values: the ones in the day's data, and from 11 " +
        "September 2020, the ones in service that day, at 0 when the dispatch leaves them out",
      example: ["HLY2201 HLY5", "HLY2201 HLY6"],
    }),
    data: z.array(timeseriesRow(nzTime)).openapi({
      description:
        "A row for each 5-minute interval (or half-hour trading period, before 11 September 2020): its NZ time, " +
        "then each unit's generation less load (MW)",
      example: [["2026-10-14T07:35:00", 398.2, 40.1]],
    }),
    pricing: z.array(nullableTimeseriesRow(nzTime)).openapi({
      description:
        "A row for each interval: its NZ time, then each unit's price ($/MWh), or null where there's none (the " +
        "metered data before 11 September 2020, or an interval the dispatch leaves the unit out of)",
      example: [["2026-10-14T07:35:00", 182.4, 182.4]],
    }),
  }),
}).openapi("GeneratorDay", { description: "A generating station and its dispatch on a day" });

const site = z.string().openapi({
  description: "The station's site code, or its alias, in any case",
  example: "HLY",
});

const NO_GENERATOR = "No generator with this site code";
const NO_DATA = "No data for this date";
const NOT_SYNCED = "Live dispatch data is temporarily unavailable";

const stationResponses = {
  200: json("The station", GeneratorDaySchema),
  503: message("The dispatch hasn't been synced yet"),
};

const todayRoute = createRoute({
  method: "get",
  path: "/{site}",
  middleware: [edgeCache] as const,
  tags: ["Generators"],
  operationId: "getGenerator",
  summary: "A station and its dispatch today",
  description:
    "A station from `/v1/generators`, with each unit's generation less load and price in each 5-minute interval so " +
    "far today (NZ), from EMI's real-time dispatch, its energy, peak and latest interval, and its outages. The same " +
    "as `/v1/generators/{site}/{date}` for today. It's cached until the next interval is due.",
  request: { params: z.object({ site }) },
  responses: { ...stationResponses, 404: message(NO_GENERATOR) },
});

app.openapi(todayRoute, async (c) => {
  const generator = await findGenerator(c.req.valid("param").site);
  if (!generator) {
    return c.json({ message: NO_GENERATOR }, 404);
  }

  const day = await getStationDay(generator, todayInNz());
  if (day === "notSynced") {
    return getServiceUnavailableResponse(c, NOT_SYNCED);
  }
  if (day === "noData") {
    return c.json({ message: NO_DATA }, 404);
  }
  return c.json(day.body, 200, { "Cache-Control": `max-age=${day.maxAge}` });
});

const INVALID_DATE = "Invalid date, expected an NZ date like 2026-10-14";

const dayRoute = createRoute({
  method: "get",
  path: "/{site}/{date}",
  middleware: [edgeCache] as const,
  tags: ["Generators"],
  operationId: "getGeneratorDay",
  summary: "A station and its dispatch on a day",
  description:
    "A station from `/v1/generators`, with each unit's generation less load and price in each 5-minute interval of " +
    "an NZ day, its energy, peak and latest interval, and its outages. It's from EMI's daily dispatch files, or " +
    "until EMI publishes a day's file (the day after), the real-time dispatch, which keeps the last 3 days. Before " +
    "11 September 2020 (back to August 1997) it's each unit's average metered generation in each half-hour trading " +
    "period instead, without prices.",
  request: {
    params: z.object({
      site,
      date: z
        .string()
        .refine((date) => toIsoDate(date) !== null, INVALID_DATE)
        .openapi({ description: "An NZ day, as YYYY-MM-DD or YYYYMMDD", example: "2026-10-14" }),
    }),
  },
  responses: {
    ...stationResponses,
    400: message(INVALID_DATE),
    404: message(`${NO_GENERATOR}, or ${NO_DATA.toLowerCase()}`),
  },
});

app.openapi(dayRoute, async (c) => {
  const params = c.req.valid("param");
  const generator = await findGenerator(params.site);
  if (!generator) {
    return c.json({ message: NO_GENERATOR }, 404);
  }

  const day = await getStationDay(generator, toIsoDate(params.date)!);
  if (day === "notSynced") {
    return getServiceUnavailableResponse(c, NOT_SYNCED);
  }
  if (day === "noData") {
    return c.json({ message: NO_DATA }, 404);
  }
  return c.json(day.body, 200, { "Cache-Control": `max-age=${day.maxAge}` });
});

// by site code, or failing that, alias (e.g. TCC for Stratford), in any case
async function findGenerator(site: string): Promise<GeneratorDefinition | undefined> {
  const code = site.toUpperCase();
  const generators = await getGenerators();
  return (
    generators.find((generator) => generator.site === code) ??
    generators.find((generator) => generator.alias === code)
  );
}

// YYYY-MM-DD or YYYYMMDD as YYYY-MM-DD, or null if it isn't a real date (e.g. 2026-02-30, which Date.parse takes to be
// 2 March)
function toIsoDate(input: string): string | null {
  const match = /^(\d{4})(-?)(\d{2})\2(\d{2})$/.exec(input);
  if (!match) {
    return null;
  }
  const date = `${match[1]}-${match[3]}-${match[4]}`;
  const time = Date.parse(date);
  return !isNaN(time) && new Date(time).toISOString().slice(0, 10) === date ? date : null;
}

type DaySource =
  | { timeseries: Timeseries; live: false }
  | { timeseries: Timeseries; live: true; lastUpdated: string };

// a day's dispatch: EMI's daily file (or the metered data, before the dispatch data began) once it's published, and
// until then the live dispatch's rows on the day, which it keeps for the last few days, so it isn't read for days
// outside them. today is always the live dispatch's, even before its first interval, so it's only unavailable when the
// live dispatch hasn't been synced
async function readDay(date: string, today: string): Promise<DaySource | "notSynced" | "noData"> {
  if (date !== today) {
    const published = await readDispatchDay(date.replace(/-/g, ""));
    if (published) {
      return { timeseries: published, live: false };
    }
    if (date > today || date < addDays(today, -TIMESERIES_DAYS)) {
      return "noData";
    }
  }

  const file = await env.dispatch.get("timeseries");
  if (!file) {
    return date === today ? "notSynced" : "noData";
  }
  const timeseries = (await file.json()) as Timeseries;
  if (date !== today && !timeseries.data.some((row: any[]) => row[0].startsWith(date))) {
    return "noData";
  }
  return { timeseries, live: true, lastUpdated: timeseries.data[timeseries.data.length - 1][0] };
}

// the outages going on at any time in a day, by unit, from the ones the sync keeps (from 14 days ago). older days'
// outages aren't in it, so they're null (/v1/outages/{date} asks POCP for them)
async function getDayOutages(
  date: string,
  today: string,
): Promise<Record<string, PocpOutage[]> | null> {
  if (date <= addDays(today, -OUTAGE_DAYS_BEFORE)) {
    return null;
  }
  const from = parseNzTime(`${date}T00:00`);
  const to = parseNzTime(`${addDays(date, 1)}T00:00`);
  const outages = await getOutageListFromCache();
  return Object.fromEntries(
    Object.entries(outages).map(([node, unitOutages]) => [
      node,
      unitOutages.filter(
        (outage) => Date.parse(outage.timeStart) < to && Date.parse(outage.timeEnd) > from,
      ),
    ]),
  );
}

// a station's definition, with its units' dispatch on the date and their outages. the live dispatch is cached until its
// next interval is due. a published day is cached for an hour while its outages can still be revised (POCP revises
// them for a few days after they end), and a day after that, as /v1/dispatch/{date} is
async function getStationDay(generator: GeneratorDefinition, date: string) {
  const today = todayInNz();
  const [source, outages] = await Promise.all([readDay(date, today), getDayOutages(date, today)]);
  if (source === "notSynced" || source === "noData") {
    return source;
  }

  const nodes = getStationNodes(generator.units, source.timeseries.series, date);
  const dispatch = selectNodesOnDate(source.timeseries, nodes, date);
  const lastTime: string | undefined = dispatch.data[dispatch.data.length - 1]?.[0];
  const hours = !source.live
    ? hoursInNzDay(date)
    : lastTime
      ? hoursToEndOfInterval(date, lastTime)
      : 0;
  const summary = summariseDay(dispatch, hours);

  const maxAge = source.live
    ? calculateMaxAgeHeader(source.timeseries)
    : outages
      ? ONE_HOUR_IN_SECONDS
      : ONE_DAY_IN_SECONDS;

  return {
    body: {
      ...generator,
      date,
      live: source.live,
      lastUpdated: source.live ? source.lastUpdated : undefined,
      summary: summary.station,
      units: generator.units.map((unit) => ({
        ...unit,
        summary: summary.units.get(unit.node),
        outages: outages ? toUnitOutages(outages[unit.node]) : undefined,
      })),
      dispatch,
    },
    maxAge,
  };
}

export default app;
