import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchCachedDataFromEmiApi } from "../clients/emiApi";
import { getGenerators } from "../clients/generators";
import { getSubstations } from "../clients/substations";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import { env } from "cloudflare:workers";
import { getOutageListFromCache, getOutageListFromPocp } from "../clients/pocpApi";
import { getNZDateTime } from "../services/nzDateTime";

const app = new Hono();
app.use(cors());


// for backwards compatability with the old dispatch api, this will be removed in the future
app.get("/generators", async (c) => {
	const generators = await getGenerators();

	const rtd = await fetchCachedDataFromEmiApi();
	const rtdData = rtd as RealTimeDispatch[];

	const outagesByUnit = await getOutageListFromCache();

	const rtdUnits = {} as Record<string, RealTimeDispatch>;
	for (const item of rtdData) {
		if (item.PointOfConnectionCode.split(' ').length == 2) {
			rtdUnits[item.PointOfConnectionCode] = item;
		}
	}

	const lastSynced = rtdData[0].FiveMinuteIntervalDatetime;

	for (const generator of generators as any[]) {
		for (const unit of generator.units) {
			unit.generation = rtdUnits[unit.node]?.SPDGenerationMegawatt ?? 0;
			unit.outage = outagesByUnit[unit.node]?.map((o: any) => {
				return {
					outageBlock: o.outageBlock,
					mwLost: o.mwattLost,
					mwRemain: o.mwattRemaining,
					from: o.timeStart,
					until: o.timeEnd,
				}
			}) || [];
		}
	}

	return c.json({
		generators: generators,
		lastUpdate: lastSynced,
	});
})

app.get("/nzgrid", async (c) => {
	const substations = await getSubstations();
	const generators = await getGenerators();

	const rtd = await fetchCachedDataFromEmiApi();
	const rtdData = rtd as RealTimeDispatch[];

	const units = {} as Record<string, any>;
	for (const unit of rtdData) {
		units[unit.PointOfConnectionCode.substring(0, 3)] = [...(units[unit.PointOfConnectionCode.substring(0, 3)] || []), unit];
	}

	const generatorsMap = {} as Record<string, any>;
	for (const generator of generators) {
		for (const unit of generator.units) {
			generatorsMap[unit.node] = generator;
		}
	}

	const substationResponses = [] as any[];

	for (const substation of substations) {
		let busbars = {} as Record<string, any>;
		let totalGenerationMW = 0;
		let totalLoadMW = 0;
		let netImportMW = 0;
		let totalGenerationCapacityMW = 0;
		for (const unit of units[substation.siteId]) {

			let generatorInfo = {}
			if (unit.PointOfConnectionCode.split(' ').length == 2) {
				const generator = generatorsMap[unit.PointOfConnectionCode];
				if (generator) {
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
				voltage: unit.PointOfConnectionCode.substring(3, 6),
				busNumber: unit.PointOfConnectionCode.substring(6, 7),
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
	const voltage = pointOfConnectionCode.substring(3, 6);
	const number = pointOfConnectionCode.substring(6, 7);
	return `${voltage}kV - ${number}`;
}

app.get("history/generation/:date", async (c) => {
	const date = c.req.param("date");
	const formattedDate = date.replace(/-/g, '');

	const [response, generators] = await Promise.all([
		env.dispatch.get(`dispatch-${formattedDate}`),
		getGenerators()
	]);

	const generatorLookup = {};
	for (const generator in generators) {
		const details = generators[generator];
		for (const node in details.units) {
			const nodeDetails = details.units[node]
			generatorLookup[nodeDetails.node] = {
				site: details.site,
				fuel: nodeDetails.fuelCode
			}
		}
	}

	const now = getNZDateTime();
	
	// if the date requested is today, use our 'live' cache.
	if (date === now.toISOString().split('T')[0]) {
		let out = {} as Record<string, any>;
		const timeseries = await env.dispatch.get("timeseries");
		if(!timeseries){
			c.status(404);
			return c.json({ message: "No data for this date" });
		}
		const json = await timeseries.json();

		for(const row in json.data){
			let rowDetails = [];
			const rowData = json.data[row];
			const timestamp = rowData[0];

			if(timestamp.split('T')[0] !== date){
				continue;
			}

			for(const genIndex in generators){
				const generator = generators[genIndex];
				let genOutput = {};
				for(const unitIndex in generator.units){
					const unit = generator.units[unitIndex];

					genOutput[unit.fuelCode] = genOutput[unit.fuelCode] ? genOutput[unit.fuelCode] + rowData[json.series.indexOf(unit.node) + 1] : rowData[json.series.indexOf(unit.node) + 1]
				}

				Object.keys(genOutput).forEach((fuelCode) => {
					rowDetails.push({
						site: generator.site,
						fuel: fuelCode,
						gen: genOutput[fuelCode]
					})
				})
			}

			out[timestamp] = rowDetails;
		}
		return c.json(out);
	}

	if (!response) {
		c.status(404);
		return c.json({ message: "No data for this date" });
	}

	const json = await response.json();

	let out = {}

	let gensWithNoData = new Set<string>();

	for (const key in json) {
		let timestampOutput = []
		let nodes = [];
		for (const node in json[key]) {
			const nodeDetails = json[key][node];
			const genNodeDetails = generatorLookup[nodeDetails.p];
			if (!genNodeDetails) {
				if (nodeDetails.p.split(' ').length == 2) {
					gensWithNoData.add(nodeDetails.p);
				}
				continue;
			}

			if (nodes.includes(nodeDetails.p)) {
				continue;
			}

			//todo merge into existing if already exists
			timestampOutput.push({
				site: genNodeDetails.site,
				fuel: genNodeDetails.fuel,
				gen: +nodeDetails.g,
				node: nodeDetails.p,
			})

			nodes.push(nodeDetails.p);
		}
		out[key] = timestampOutput;
	}

	gensWithNoData.size > 0 && console.warn("Generators with no data for " + date + ": " + Array.from(gensWithNoData).join(', '))

	return c.json(out)
})

app.get("history/price/:date", async (c) => {
	const date = c.req.param("date");
	const formattedDate = date.replace(/-/g, '');
	const response = await env.dispatch.get(`dispatch-${formattedDate}`);

	if (!response) {
		c.status(404);
		return c.json({ message: "No data for this date" });
	}

	const json = await response.json();

	let out = {}

	for (const key in json) {
		let thisTimestamp = {};
		for (const node in json[key]) {
			const thisNode = json[key][node];
			// this is a little hacky - might inadvetantly pick the wrong benmore/otahuhu node
			if (thisNode.p.startsWith("OTA")) {
				thisTimestamp["OTA2201"] = +thisNode.c;
			} else if (thisNode.p.startsWith("BEN")) {
				thisTimestamp["BEN2201"] = +thisNode.c;
			}
		}
		out[key] = thisTimestamp;
	}

	return c.json(out)
})

export default app;