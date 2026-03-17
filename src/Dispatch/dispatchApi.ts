import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Dispatch } from "./model";
import { getGenerators, getGeneratorUnits } from "./generators";
import { checkForMissingUnits } from "./missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi } from "./emiApi";
import { RealTimeDispatch } from "./models/realTimeDispatch";

const app = new Hono();
app.use(cors());

app.get("/legacy/generators", async (c) => {
	const generators = await getGenerators();
	
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json() as RealTimeDispatch[];

	const rtdUnits = {} as Record<string, RealTimeDispatch>;
	for(const item of rtdData){
		if(item.PointOfConnectionCode.split(' ').length == 2){
			rtdUnits[item.PointOfConnectionCode] = item;
		}
	}

	const lastSynced = rtdData[0].FiveMinuteIntervalDatetime;

	for(const generator of generators as any[]){
		for(const unit of generator.units){
			unit.generation = rtdUnits[unit.node]?.SPDGenerationMegawatt ?? 0;
			// todo add outages
		}
	}

	return c.json({
		generators: generators,
		lastUpdate: lastSynced,
	});
})

app.get("/legacy/price-history/:date", async (c) => {
	const date = c.req.param('date');
	const dispatch = await env.DB.prepare(`SELECT * FROM real_time_dispatch WHERE FiveMinuteIntervalDatetime like ? AND PointOfConnectionCode in ('OTA2201', 'BEN2201') `).bind(date + '%').all();
	const dispatchResults = dispatch.results as Dispatch[];

	var priceMap: Record<string, any> = {};
	for(const dispatch of dispatchResults){
		const dateTime = dispatch.FiveMinuteIntervalDatetime || dispatch['FiveMinuteIntervalDateTime'];
		
		priceMap[dateTime] = priceMap[dateTime] || {};
		priceMap[dateTime][dispatch.PointOfConnectionCode] = dispatch.DollarsPerMegawattHour;
	}

	return c.json(priceMap);
})

app.get("/legacy/generator-history/:date", async (c) => {
	const date = c.req.param('date');
	const dispatch = await env.DB.prepare(`SELECT * FROM real_time_dispatch WHERE FiveMinuteIntervalDatetime > ? and FiveMinuteIntervalDatetime < ? and PointOfConnectionCode like '% %' and NOT (SPDLoadMegawatt == 0 and SPDGenerationMegawatt == 0)`).bind(date, date + 'T23:59:00').all();
	var dispatchResults = dispatch.results as Dispatch[];

	const generatorUnits = await getGeneratorUnits();
	
	var dispatchMap: Record<string, any[]> = {};
	for(const dispatch of dispatchResults){
		const dateTime = dispatch.FiveMinuteIntervalDatetime || dispatch['FiveMinuteIntervalDateTime'];

		const unit = generatorUnits[dispatch.PointOfConnectionCode];

		const generation = dispatch.SPDGenerationMegawatt - dispatch.SPDLoadMegawatt;

		if(generation === 0){
			continue;
		}

		const element = {
			site: unit.site,
			fuel: unit.fuelCode,
			gen: dispatch.SPDGenerationMegawatt - dispatch.SPDLoadMegawatt
		}
		dispatchMap[dateTime] = dispatchMap[dateTime] || [];

		const existingElement = dispatchMap[dateTime].find(element => element.site === unit.site && element.fuel === unit.fuelCode);
		if(existingElement){
			existingElement.gen += dispatch.SPDGenerationMegawatt - dispatch.SPDLoadMegawatt;
		} else {
			dispatchMap[dateTime].push(element);
		}

	}
	return c.json(dispatchMap);
})

app.get("/delta", async (c) => {
	const lastSynced = await env.DB.prepare(`SELECT MAX(FiveMinuteIntervalDatetime) FROM real_time_dispatch`).first("MAX(FiveMinuteIntervalDatetime)") as string;
	const dispatchList = await env.DB.prepare(`SELECT DISTINCT PointOfConnectionCode FROM real_time_dispatch`).all();
	const dispatchListResult = dispatchList.results.map(dispatch => dispatch.PointOfConnectionCode) as string[];

	const missingUnits = await checkForMissingUnits(dispatchListResult);
	
	return c.json({
		lastSynced: lastSynced,
		missingUnits: missingUnits
	});
})

app.get("/rtd", async (c) => {
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json();
	return c.json(rtdData);
})

export default app;