import substations from '../data/substations.json' with { type: 'json' };

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
	return substations;
}