import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Dispatch } from "./model";
import { getGenerators, getGeneratorUnits } from "./generators";
import { checkForMissingUnits } from "./missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi } from "./emiApi";
import { RealTimeDispatch } from "./models/realTimeDispatch";
import { getSubstations } from "./substations";

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
			unit.outage = []
			// todo add outages
		}
	}

	return c.json({
		generators: generators,
		lastUpdate: lastSynced,
	});
})

app.get("/legacy/nzgrid", async (c) => {
	const substations = await getSubstations();
	const generators = await getGenerators();

	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json() as RealTimeDispatch[];

	const units = {} as Record<string, any>;
	for (const unit of rtdData) {
		units[unit.PointOfConnectionCode.substring(0,3)] = [...(units[unit.PointOfConnectionCode.substring(0,3)] || []), unit];
	}

	const generatorsMap = {} as Record<string, any>;
	for(const generator of generators){
		for(const unit of generator.units){
			generatorsMap[unit.node] = generator;
		}
	}

	for(const substation of substations){
		let busbars = {};
		let totalGenerationMW = 0;
		let totalLoadMW = 0;
		let netImportMW = 0;
		let totalGenerationCapacityMW = 0;
		for(const unit of units[substation.siteId]){

			let generatorInfo = {}
			if(unit.PointOfConnectionCode.split(' ').length == 2){
				const generator = generatorsMap[unit.PointOfConnectionCode];
				if(generator){
					const generatorUnit = generator.units.find((unitA: any) => unitA.node == unit.PointOfConnectionCode)
					totalGenerationCapacityMW += generatorUnit?.capacity ?? 0;
					generatorInfo = {
						plantName: generator.name,
						operator: generator.operator,
						technology: "",
						fuel: generatorUnit?.fuel ?? "",
						nameplateCapacityMW: generatorUnit?.capacity ?? 0,
					}
				} else {
					generatorInfo = {
						plantName: "Unknown"
					}
				}
			}

			const currentBusbar = busbars[getBusbarName(unit.PointOfConnectionCode)];
			busbars[getBusbarName(unit.PointOfConnectionCode)] = {
				connections: [
					...(currentBusbar?.connections || []),
					{
						identifier: unit.PointOfConnectionCode,
						loadMW: unit.SPDLoadMegawatt,
						generationMW: unit.SPDGenerationMegawatt,
						generatorInfo: generatorInfo
					}
				],
				priceDollarsPerMegawattHour: unit.DollarsPerMegawattHour,
				voltage: unit.PointOfConnectionCode.substring(3,6),
				busNumber: unit.PointOfConnectionCode.substring(6,7),
				totalGenerationMW: (currentBusbar?.totalGenerationMW ?? 0) + unit.SPDGenerationMegawatt,
				totalLoadMW: (currentBusbar?.totalLoadMW ?? 0) + unit.SPDLoadMegawatt,
				netImportMW: (currentBusbar?.netImportMW ?? 0) + (unit.SPDLoadMegawatt - unit.SPDGenerationMegawatt),
			};
			totalGenerationMW += unit.SPDGenerationMegawatt;
			totalLoadMW += unit.SPDLoadMegawatt;
			netImportMW += unit.SPDLoadMegawatt - unit.SPDGenerationMegawatt;
		}
		substation['busbars'] = busbars;
		substation['totalGenerationMW'] = totalGenerationMW;
		substation['totalLoadMW'] = totalLoadMW;
		substation['netImportMW'] = netImportMW;
		substation['totalGenerationCapacityMW'] = totalGenerationCapacityMW;
		// todo totalGenerationCapacityMW
	}

	return c.json({
		sites: substations,
		lastUpdate: rtdData[0].FiveMinuteIntervalDatetime,
	})
})

function getBusbarName(pointOfConnectionCode: string) {
	const voltage = pointOfConnectionCode.substring(3,6);
	const number = pointOfConnectionCode.substring(6,7);
	return `${voltage}kV - ${number}`;
}

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
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json() as RealTimeDispatch[];

	const dispatchList = rtdData.map(item => item.PointOfConnectionCode) as string[];

	const missingUnits = await checkForMissingUnits(dispatchList);
	
	return c.json({
		lastSynced: rtdData[0].FiveMinuteIntervalDatetime,
		missingUnits: missingUnits
	});
})

app.get("/rtd", async (c) => {
	const rtd = await fetchDataFromEmiApi();
	const rtdData = await rtd.json();
	return c.json(rtdData);
})

export default app;