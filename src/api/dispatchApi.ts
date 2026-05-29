import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi } from "../clients/emiApi";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import legacyDispatchApi from "./legacyDispatchApi";
import { getSubstations } from "../clients/substations";
import { mapBySiteCode } from "../services/rtdMapping/mapBySiteCode";
import { getGenerators } from "../clients/generators";
import { mapByPointOfConnectionCode } from "../services/rtdMapping/mapByPointOfConnectionCode";

const app = new Hono();
app.use(cors());

app.route('/legacy', legacyDispatchApi);


app.get("/delta", async (c) => {
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json() as RealTimeDispatch[];

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
	const timeseries = await env.dispatch.get("timeseries");
	const json = await timeseries.json();
	if(timeseries){
		return c.json(json);
	} else {
		return c.json({series: [], data: []});
	}
})

app.get("/latest", async (c) => {
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json() as RealTimeDispatch[];

	const siteCodeMap = mapBySiteCode(rtdData);
	const pointOfConnectionCodeMap = mapByPointOfConnectionCode(rtdData);

	const substations = await getSubstations();
	const generators = await getGenerators();

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
				dispatch: pointOfConnectionCodeMap.get(unit.node)
			}))
		}))
	});
})

export default app;