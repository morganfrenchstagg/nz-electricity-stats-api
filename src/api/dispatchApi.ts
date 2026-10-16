import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi, fetchCachedDataFromEmiApi } from "../clients/emiApi";
import legacyDispatchApi from "./legacyDispatchApi";
import aggregatesApi from "./aggregatesApi";
import { getSubstations } from "../clients/substations";
import { mapBySiteCode } from "../services/rtdMapping/mapBySiteCode";
import { getGenerators } from "../clients/generators";
import { mapByPointOfConnectionCode } from "../services/rtdMapping/mapByPointOfConnectionCode";
import { filterTimeseriesSince } from "../services/timeseries/timeseries";
import { getOutageListFromCache } from "../clients/pocpApi";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { getJsonResponseWithHeaders, getJsonResponseWithMaxAgeHeader, getServiceUnavailableResponse } from "../utilities/utilities";
import { getNZDateTime } from "../services/nzDateTime";
import { Timeseries } from "../models/timeseries";
import { MeteredGenerationRecord } from "../models/meteredGenerationRecord";
import { METERED_DAY_PREFIX } from "../services/meteredGeneration/meteredGeneration";
import { DISPATCH_AGGREGATES_START } from "../services/dispatchAggregation/dispatchAggregation";

const app = new Hono();
app.use(cors());

app.route('/legacy', legacyDispatchApi);
app.route('/aggregates', aggregatesApi);


app.get("/delta", async (c) => {
	const rtdData = await fetchCachedDataFromEmiApi();
	if (!rtdData) {
		return getServiceUnavailableResponse("Live dispatch data is temporarily unavailable");
	}

	const dispatchList = rtdData.map(item => item.PointOfConnectionCode) as string[];

	const missingUnits = await checkForMissingUnits(dispatchList);

	return c.json({
		lastUpdated: rtdData[0].FiveMinuteIntervalDatetime,
		missingUnits: missingUnits
	});
})

app.get("/rtd", async (c) => {
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json();
	return c.json(rtdData);
})

// timestamps are NZ times, in the same format as the ones returned
const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// optionally only return the intervals after a timestamp, e.g. ?since=2026-10-14T21:55:00
app.get("/recent", async (c) => {
	const since = c.req.query("since");
	if (since !== undefined && !SINCE_FORMAT.test(since)) {
		c.status(400);
		return c.json({ message: "Invalid since, expected an NZ time like 2026-10-14T21:55:00" });
	}

	const timeseries = await env.dispatch.get("timeseries");
	if (!timeseries) {
		return c.json({ series: [], data: [], pricing: [] });
	}

	const json = await timeseries.json() as Timeseries;
	// based on the full timeseries, as the filtered one can be empty
	const maxAge = calculateMaxAgeHeader(json);

	return getJsonResponseWithHeaders(since ? filterTimeseriesSince(json, since) : json, { "Cache-Control": `max-age=${maxAge}` });
})

const DEFAULT_MAX_AGE = 30;

function calculateMaxAgeHeader(timeseries: Timeseries): number {
	const latestTimestamp = timeseries.data[timeseries.data.length - 1][0];

	const latestDate = new Date(latestTimestamp);
	const nextDate = new Date(latestDate.setTime(latestDate.getTime() + 6 * 1000 * 60)); // 6 minutes later (5 min + 1)
	const now = getNZDateTime();

	const cachableTimeInSeconds = (nextDate.getTime() - now.getTime()) / 1000;
	return cachableTimeInSeconds > 0 ? cachableTimeInSeconds : DEFAULT_MAX_AGE;
}

app.get("/latest", async (c) => {
	const [rtdData, outages, substations, generators] = await Promise.all([
		fetchCachedDataFromEmiApi(),
		getOutageListFromCache(),
		getSubstations(),
		getGenerators()
	]);

	if (!rtdData) {
		return getServiceUnavailableResponse("Live dispatch data is temporarily unavailable");
	}

	const siteCodeMap = mapBySiteCode(rtdData);
	const pointOfConnectionCodeMap = mapByPointOfConnectionCode(rtdData);

	return c.json({
		lastUpdated: rtdData[0].FiveMinuteIntervalDatetime,
		substations: substations.map(substation => ({
			...substation,
			pointsOfConnection: siteCodeMap.get(substation.siteId)
		})),
		generators: generators.map(generator => ({
			...generator,
			units: generator.units.map(unit => ({
				...unit,
				dispatch: pointOfConnectionCodeMap.get(unit.node),
				outages: outages[unit.node]?.map((o) => ({
					outageBlock: o.outageBlock,
					mwLost: o.mwattLost,
					mwRemain: o.mwattRemaining,
					from: o.timeStart,
					until: o.timeEnd,
				})) || []
			}))
		}))
	});
})

// a day's dispatch by interval, or its metered generation by trading period for the days the aggregates take from
// metered generation (including the first, partial, day of dispatch files). each falls back to the other, e.g. while
// the metered generation is still being backfilled
app.get("/:date", async (c) => {
	const date = c.req.param("date").replace(/-/g, '');
	const keys = date < DISPATCH_AGGREGATES_START.replace(/-/g, '')
		? [METERED_DAY_PREFIX + date, `dispatch-${date}`]
		: [`dispatch-${date}`, METERED_DAY_PREFIX + date];
	const file = await env.dispatch.get(keys[0]) ?? await env.dispatch.get(keys[1]);

	if (!file) {
		c.status(404);
		return c.json({ message: "No data for this date" });
	}

	const intervals = await file.json() as Record<string, (HistoricalDispatchRecord | MeteredGenerationRecord)[]>;
	return getJsonResponseWithMaxAgeHeader(toDayTimeseries(intervals));
})

// the daily files leave out most nodes while they're at 0MW generation and load, so a node missing from an interval
// is 0 rather than unknown. intervals missing from the file entirely are still left out. metered generation has no
// prices, so its prices are all null
function toDayTimeseries(intervals: Record<string, (HistoricalDispatchRecord | MeteredGenerationRecord)[]>): Timeseries {
	const series = [...new Set(Object.values(intervals).flatMap(records => records.map(record => record.p)))];
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