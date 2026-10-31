import { env } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { AggregateDataPoint, AggregateResolution, DispatchAggregate } from "../models/dispatchAggregate";
import { Timeseries } from "../models/timeseries";
import {
	calculateLiveDailyEnergy,
	getAggregateKey,
	getMonthBounds,
	toTimeseries,
	upsertDataPoint
} from "../services/dispatchAggregation/dispatchAggregation";
import { LATEST_AGGREGATED_DATE_KEY, LatestAggregatedDateMetadata } from "../sync/syncDispatchAggregates";
import { LATEST_METERED_HVDC_DATE_KEY } from "../sync/syncHvdcHistory";
import { HVDC_AGGREGATE_PREFIX } from "../services/hvdc/hvdc";
import { getJsonResponseWithHeaders, ONE_DAY_IN_SECONDS } from "../utilities/utilities";

// how long to cache periods still receiving data once their next day is overdue
const OVERDUE_MAX_AGE_SECONDS = 5 * 60;

// how long to cache months that include days from the live dispatch, which gets a new interval every 5 minutes
const LIVE_MAX_AGE_SECONDS = 5 * 60;

// how long to cache periods that have ended. they only change if EMI republishes a file or the metered generation
// codes change, which is rare enough to be worth a client seeing an old copy for a while
const COMPLETE_MAX_AGE_SECONDS = 30 * ONE_DAY_IN_SECONDS;

const app = new Hono();
app.use(cors());

app.get("/", async (c) => {
	return c.json({
		latestDate: await env.dispatch_kv.get(LATEST_AGGREGATED_DATE_KEY)
	});
});

// e.g. /2026/weekly - one data point per ISO week (Monday to Sunday) in the year
app.get("/:year{[0-9]{4}}/weekly", async (c) => {
	return getAggregateResponse(c, "weekly", c.req.param("year"));
});

// e.g. /2026/monthly - one data point per month in the year
app.get("/:year{[0-9]{4}}/monthly", async (c) => {
	return getAggregateResponse(c, "monthly", c.req.param("year"));
});

// e.g. /2026/10 - one data point per day in the month
app.get("/:year{[0-9]{4}}/:month{[0-9]{1,2}}", async (c) => {
	const month = +c.req.param("month");
	if (month < 1 || month > 12) {
		c.status(400);
		return c.json({ message: "Invalid month, expected 1-12" });
	}
	return getAggregateResponse(c, "daily", `${c.req.param("year")}-${String(month).padStart(2, "0")}`);
});

// /annual - one data point per year
app.get("/annual", async (c) => {
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

	let aggregate = file ? await file.json() as DispatchAggregate : null;
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
		c.status(404);
		return c.json({ message: "No data for this period" });
	}

	// optionally filter by a comma separated list of node prefixes, e.g. ?nodes=HLY2201,ABY0111
	const nodeFilter = c.req.query("nodes")?.split(",").map(node => node.trim()).filter(node => node.length > 0);
	const timeseries = toTimeseries(aggregate, nodeFilter);
	// the MWh it sent north and south in each period
	const hvdc = hvdcFile ? toTimeseries(await hvdcFile.json() as DispatchAggregate) : { series: [], data: [] };

	return getJsonResponseWithHeaders({ ...timeseries, hvdc }, { "Cache-Control": `max-age=${maxAgeSeconds}` });
}

// the days in the month (e.g. 2026-10) the live dispatch has that haven't been aggregated yet
async function getLiveDays(month: string, latestDate: string | null, aggregate: DispatchAggregate | null): Promise<AggregateDataPoint[]> {
	const file = await env.dispatch.get("timeseries");
	if (!file) {
		return [];
	}

	// KV can lag behind R2 for a little while, so the aggregate file can already have a day after latestDate
	const aggregated = new Set(aggregate?.data.map(day => day.from));

	return calculateLiveDailyEnergy(await file.json() as Timeseries)
		.filter(day => day.from.slice(0, 7) === month && (latestDate === null || day.from > latestDate) && !aggregated.has(day.from));
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
