import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi, fetchCachedDataFromEmiApi } from "../clients/emiApi";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import legacyDispatchApi from "./legacyDispatchApi";
import { getSubstations } from "../clients/substations";
import { mapBySiteCode } from "../services/rtdMapping/mapBySiteCode";
import { getGenerators } from "../clients/generators";
import { mapByPointOfConnectionCode } from "../services/rtdMapping/mapByPointOfConnectionCode";
import { generateTimeseries } from "../services/timeseries/timeseries";
import { getOutageListFromCache } from "../clients/pocpApi";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { getJsonResponseWithHeaders, getJsonResponseWithMaxAgeHeader } from "../utilities/utilities";
import { getNZDateTime } from "../services/nzDateTime";
import { Timeseries } from "../models/timeseries";

const app = new Hono();
app.use(cors());

app.route('/legacy', legacyDispatchApi);


app.get("/delta", async (c) => {
	const rtd = await fetchCachedDataFromEmiApi();
	const rtdData = rtd as RealTimeDispatch[];

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

app.get("/recent", async (c) => {
	const timeseries = (await env.dispatch.get("timeseries"))!
	const json = await timeseries.json() as Timeseries;
	if (timeseries) {
		return getJsonResponseWithHeaders(json, { "Cache-Control": `max-age=${calculateMaxAgeHeader(json)}` });
	} else {
		return c.json({ series: [], data: [] });
	}
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
	const [rtd, outages, substations, generators] = await Promise.all([
		fetchCachedDataFromEmiApi(),
		getOutageListFromCache(),
		getSubstations(),
		getGenerators()
	]);

	const rtdData = rtd as RealTimeDispatch[];
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

app.get("/:date", async (c) => {
	const date = c.req.param("date");
	const formattedDate = date.replace(/-/g, '');
	const response = await env.dispatch.get(`dispatch-${formattedDate}`);

	if (!response) {
		c.status(404);
		return c.json({ message: "No data for this date" });
	}

	const json = (await response.json()) as Record<string, HistoricalDispatchRecord[]>;

	let timeseries = { series: [], data: [], pricing: [] } as any;

	// construct list of 'series'
	for (const timestamp in json) {
		for (const dp in json[timestamp]) {
			const dataPoint = json[timestamp][dp]
			if (!timeseries.series.includes(dataPoint.p)) {
				timeseries.series.push(dataPoint.p)
			}
		}
	}

	// populate data and pricing
	for (const timestamp in json) {
		let dataArr = new Array(timeseries.series.length + 1).fill(null);
		let priceArr = new Array(timeseries.series.length + 1).fill(null);
		dataArr[0] = timestamp;
		priceArr[0] = timestamp;

		for (const dp in json[timestamp]) {
			const dataPoint = json[timestamp][dp];
			dataArr[timeseries.series.indexOf(dataPoint.p) + 1] = (+dataPoint.g - +dataPoint.l);
			priceArr[timeseries.series.indexOf(dataPoint.p) + 1] = +dataPoint.c;
		}

		timeseries.data.push(dataArr);
		timeseries.pricing.push(priceArr);
	}

	return getJsonResponseWithMaxAgeHeader(timeseries);
})


export default app;