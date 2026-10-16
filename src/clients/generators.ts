import generators from '../data/generators.json' with { type: 'json' };

export async function getGenerators(): Promise<GeneratorDefinition[]> {
	return generators;
}

export type GeneratorDefinition = {
	site: string;
	name: string;
	units: UnitDefinition[];
	location: LocationDefinition;
	gridZone: string;
	operator: string;
	scheme?: string;
	alias?: string;
}

export type UnitDefinition = {
	name: string;
	unitCode: string;
	node: string;
	capacity: number;
	fuel: string;
	fuelCode: string;
	// UTC. commissioned is the first dispatch interval for sites new since the daily dispatch data began (Sep 2020),
	// otherwise when the node entered EMI's dispatched generation plant register. EMI uses 1899-12-31T12:30:00.000Z for
	// plant that was already running when the register began, and it's absent while a unit is still being commissioned.
	// decomissioned is when the node left the register, or when it stopped dispatching if the register still lists it.
	commissioned?: string;
	decomissioned?: string;
}

export type LocationDefinition = {
	lat: number;
	long: number;
}

export async function getGeneratorUnits() {
	const generators = await getGenerators();

	const unitMap: Record<string, any> = {};
	for (const generator of generators) {
		for (const unit of generator.units) {
			const unitObject = {
				...unit,
				site: generator.site,
			}
			unitMap[unit.node] = unitObject;
		}
	}

	return unitMap;
}