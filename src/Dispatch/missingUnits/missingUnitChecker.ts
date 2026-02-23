import { getGenerators } from "../generators";

export const checkForMissingUnits = async (dispatchList: string[]) => {
	const generators = await getGenerators();

	const unitsNotInDispatchList = [];
	const unitsNotInGeneratorList = dispatchList.filter(unit => (unit as string).split(' ').length > 1);
	

	for(const generator of generators){
		for(const unit of generator.units){
			if(unitsNotInGeneratorList.includes(unit.node)){
				unitsNotInGeneratorList.splice(unitsNotInGeneratorList.indexOf(unit.node), 1);
			} else if(unit.active === undefined || unit.active === true){
				unitsNotInDispatchList.push(unit.node);
			}
		}
	}

	return {
		generationUnitsNotInDispatchList: unitsNotInDispatchList,
		generationUnitsNotInGeneratorList: unitsNotInGeneratorList
	};
}