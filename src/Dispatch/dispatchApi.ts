import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Dispatch } from "./model";
import { getGenerators, getGeneratorUnits } from "./generators";

const app = new Hono();
app.use(cors());

/*app.get("/", async (c) => {
	const dispatch = await env.DB.prepare(`SELECT * FROM real_time_dispatch WHERE FiveMinuteIntervalDateTime >= DATE('now', '-1 day')`).all();
	return c.json(dispatch.results);
});*/

app.get("/legacy/generators", async (c) => {
	const generators = await getGenerators();

	const lastSynced = await env.DB.prepare(`SELECT MAX(FiveMinuteIntervalDatetime) FROM real_time_dispatch`).first("MAX(FiveMinuteIntervalDatetime)");

	const dispatchAtLastSynced = await env.DB.prepare(`SELECT * FROM real_time_dispatch WHERE FiveMinuteIntervalDatetime = ?`).bind(lastSynced).all();

	const nodes: Record<string, number> = {};
	for(const unit of dispatchAtLastSynced.results as Dispatch[]){
		nodes[unit.PointOfConnectionCode] = unit.SPDGenerationMegawatt;
	}

	for(const generator of generators as any[]){
		for(const unit of generator.units){
			unit.generation = nodes[unit.node] ?? 0;
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
	const generators = await getGenerators();

	const lastSynced = await env.DB.prepare(`SELECT MAX(FiveMinuteIntervalDatetime) FROM real_time_dispatch`).first("MAX(FiveMinuteIntervalDatetime)") as string;

	const dispatchList = await env.DB.prepare(`SELECT DISTINCT PointOfConnectionCode FROM real_time_dispatch`).all();

	const dispatchListResult = dispatchList.results.map(dispatch => dispatch.PointOfConnectionCode);

	const unitsUnaccountedForInDispatchList = dispatchListResult;
	const unitsMissingInDispatchList = [];

	for(const generator of generators){
		for(const unit of generator.units){
			if(dispatchListResult.includes(unit.node)){
				unitsUnaccountedForInDispatchList.splice(unitsUnaccountedForInDispatchList.indexOf(unit.node), 1);
			} else if(unit.active === undefined || unit.active === true) {
				unitsMissingInDispatchList.push(unit.node);
			}
		}
	}

	
	return c.json({
		lastSynced: lastSynced,
		unitsMissingInDispatchList: unitsMissingInDispatchList,
		unitsUnaccountedForInDispatchList: unitsUnaccountedForInDispatchList.filter(unit => (unit as string).split(' ').length > 1)
	});
})

export default app;