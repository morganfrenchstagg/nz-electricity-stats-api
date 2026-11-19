import generators from '../data/generators.json' with { type: 'json' };
import substations from '../data/substations.json' with { type: 'json' };
import { GeneratorDefinition, UnitDefinition } from "../clients/generators";

// what the tools group a node's generation or load by. a generating unit's node has its unit code after the point of
// connection (e.g. HLY2201 HLY5), and every other node is a grid exit point (e.g. OTA2201), where load is taken
export type UnitInfo = {
	node: string;
	unit: string;
	unitCode: string;
	station: string;
	site: string;
	operator: string;
	fuel: string;
	island: Island;
	gridZone: string;
	capacity: number;
	commissioned?: string;
	decommissioned?: string;
	// a battery's charging node, whose capacity is negative
	charging: boolean;
	// stands in for several units before the dispatch data began (see UnitDefinition.combines)
	combines?: string[];
};

export type Island = "North" | "South";

export type GxpInfo = {
	node: string;
	site: string;
	substation: string;
	island: Island | "Unknown";
};

const ISLANDS: Record<string, Island> = { NI: "North", SI: "South", north: "North", south: "South" };

// a battery's charging and discharging units are both the battery, as charging is counted as demand (see groupNodes)
const FUEL_NAMES: Record<string, string> = { "Battery (Discharging)": "Battery", "Battery (Charging)": "Battery" };

export const RENEWABLE_FUELS = new Set(["Hydro", "Geothermal", "Wind", "Solar"]);

const unitsByNode = new Map<string, UnitInfo>(
	(generators as GeneratorDefinition[]).flatMap(generator => generator.units.map(unit => [unit.node, toUnitInfo(generator, unit)])),
);

const substationsBySite = new Map(substations.map(substation => [substation.siteId, substation]));

function toUnitInfo(generator: GeneratorDefinition & { island?: string }, unit: UnitDefinition): UnitInfo {
	return {
		node: unit.node,
		unit: unit.name,
		unitCode: unit.unitCode,
		station: generator.name,
		site: generator.site,
		operator: generator.operator,
		fuel: FUEL_NAMES[unit.fuel] ?? unit.fuel,
		island: ISLANDS[generator.island ?? ""] ?? "North",
		gridZone: generator.gridZone,
		capacity: unit.capacity,
		commissioned: unit.commissioned,
		decommissioned: unit.decomissioned,
		charging: unit.fuelCode === "BESS-C",
		combines: unit.combines,
	};
}

export function isUnitNode(node: string): boolean {
	return node.includes(" ");
}

// units the dispatch has that generators.json doesn't (yet) are still generation, just without the details
export function getUnit(node: string): UnitInfo {
	const unit = unitsByNode.get(node);
	if (unit) {
		return unit;
	}
	const site = node.slice(0, 3);
	return {
		node,
		unit: node,
		unitCode: node.split(" ")[1],
		station: `Unknown (${node})`,
		site,
		operator: "Unknown",
		fuel: "Unknown",
		island: toIsland(substationsBySite.get(site)?.island) ?? "North",
		gridZone: "Unknown",
		capacity: 0,
		charging: false,
	};
}

export function getGxp(node: string): GxpInfo {
	const site = node.slice(0, 3);
	const substation = substationsBySite.get(site);
	return {
		node,
		site,
		substation: substation?.description ?? site,
		island: toIsland(substation?.island) ?? "Unknown",
	};
}

function toIsland(island: string | undefined): Island | undefined {
	return island ? ISLANDS[island] : undefined;
}

export function getAllUnits(): UnitInfo[] {
	return [...unitsByNode.values()];
}

export function getAllSubstations() {
	return substations;
}

// matches names however they're written, e.g. Otahuhu for Ōtāhuhu
export function normaliseName(name: string): string {
	return name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export const GENERATION_GROUPS = ["total", "fuel", "island", "operator", "station", "unit", "grid_zone"] as const;
export const DEMAND_GROUPS = ["total", "island", "substation", "node"] as const;
export type GenerationGroup = typeof GENERATION_GROUPS[number];
export type DemandGroup = typeof DEMAND_GROUPS[number];

export function generationGroupOf(unit: UnitInfo, groupBy: GenerationGroup): string {
	switch (groupBy) {
		case "total": return "Total";
		case "fuel": return unit.fuel;
		case "island": return unit.island;
		case "operator": return unit.operator;
		case "station": return unit.station;
		case "unit": return `${unit.unit} (${unit.node})`;
		case "grid_zone": return unit.gridZone;
	}
}

export function demandGroupOf(gxp: GxpInfo, groupBy: DemandGroup): string {
	switch (groupBy) {
		case "total": return "Total";
		case "island": return gxp.island;
		case "substation": return gxp.substation;
		case "node": return gxp.node;
	}
}

export type UnitFilter = {
	fuel?: string[];
	operator?: string[];
	island?: Island;
	station?: string[];
};

// fuels, operators and stations match case and diacritic insensitively, stations by name, site code or node prefix
export function matchesUnitFilter(unit: UnitInfo, filter: UnitFilter): boolean {
	if (filter.fuel?.length && !filter.fuel.some(fuel => normaliseName(fuel) === normaliseName(unit.fuel))) {
		return false;
	}
	if (filter.operator?.length && !filter.operator.some(operator => normaliseName(unit.operator).includes(normaliseName(operator)))) {
		return false;
	}
	if (filter.island && unit.island !== filter.island) {
		return false;
	}
	if (filter.station?.length && !filter.station.some(station => matchesStation(unit, station))) {
		return false;
	}
	return true;
}

const SITE_CODES = new Set(getAllUnits().map(unit => unit.site));

// a site code (e.g. MAN) only matches its own site, rather than every station with it in its name (e.g. Mangahao)
function matchesStation(unit: UnitInfo, station: string): boolean {
	if (SITE_CODES.has(station.toUpperCase())) {
		return unit.site === station.toUpperCase();
	}
	return normaliseName(unit.station).includes(normaliseName(station)) || unit.node.toLowerCase().startsWith(station.toLowerCase());
}
