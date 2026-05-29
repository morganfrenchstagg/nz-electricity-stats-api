export type SubstationDefinition = {
	lat: number;
	long: number;
	siteId: string;
	description: string;
	type: SubstationType;
	gridZone: number;
	island: Island;
}

export type SubstationType = 'ACSTN' | 'TEE';
export type Island = 'north' | 'south';

export async function getSubstations() {
	const substations = await fetch('https://raw.githubusercontent.com/morganfrenchstagg/nz-electricity-map/refs/heads/main/backend/data/substations.json');
	const substationsJson = await substations.json() as SubstationDefinition[];

	return substationsJson;
}