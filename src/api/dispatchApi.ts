import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getGenerators } from "../clients/generators";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi } from "../clients/emiApi";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import { getSubstations } from "../clients/substations";

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

	const substationResponses = [] as any[];

	for(const substation of substations){
		let busbars = {} as Record<string, any>;
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
		substationResponses.push({
			...substation,
			busbars: busbars,
			totalGenerationMW: totalGenerationMW,
			totalLoadMW: totalLoadMW,
			netImportMW: netImportMW,
			totalGenerationCapacityMW: totalGenerationCapacityMW,
		})
	}

	return c.json({
		sites: substationResponses,
		lastUpdated: rtdData[0].FiveMinuteIntervalDatetime,
	})
})

function getBusbarName(pointOfConnectionCode: string) {
	const voltage = pointOfConnectionCode.substring(3,6);
	const number = pointOfConnectionCode.substring(6,7);
	return `${voltage}kV - ${number}`;
}

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

app.get("/recent", async (c) => {
	const timeseries = await env.dispatch.get("timeseries");
	const json = await timeseries.json();
	if(timeseries){
		return c.json(json);
	} else {
		return c.json({series: [], data: []});
	}
})

export default app;