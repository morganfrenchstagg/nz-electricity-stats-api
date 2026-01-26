export async function getGenerators() {
	const list = await fetch('https://raw.githubusercontent.com/morganfrenchstagg/nz-electricity-map/refs/heads/main/backend/data/generators.json');
	const generationListJson = await list.json() as any[];

	return generationListJson;
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