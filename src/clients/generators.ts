export async function getGenerators() {
	const list = await fetch('https://raw.githubusercontent.com/morganfrenchstagg/nz-electricity-map/refs/heads/main/backend/data/generators.json');
	const generationListJson = await list.json() as GeneratorDefinition[];

	return generationListJson;
}

export type GeneratorDefinition = {
	site: string;
	name: string;
	units: UnitDefinition[];
	location: LocationDefinition;
	gridZone: string;
	operator: string;
	scheme: string;
	alias: string;
}

export type UnitDefinition = {
	name: string;
	unitCode: string;
	node: string;
	capacity: number;
	fuel: string;
	fuelCode: string;
}

export type LocationDefinition = {
	lat: number;
	long: number;
}

export async function getGeneratorUnits() {
	const generators = await getGenerators();

	const unitMap: Record<string, any> = {};
	for(const generator of generators){
		for(const unit of generator.units){
			const unitObject = {
				...unit,
				site: generator.site,
			}
			unitMap[unit.node] = unitObject;
		}
	}

	return unitMap;
}