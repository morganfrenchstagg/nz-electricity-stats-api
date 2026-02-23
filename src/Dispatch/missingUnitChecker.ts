import { getGenerators } from "./generators";

export const checkForMissingUnits = async (dispatchList: string[]) => {
	const generators = await getGenerators();

	const unitsNotInDispatchList = [];
	const unitsNotInGeneratorList = dispatchList;
	

	for(const generator of generators){
		for(const unit of generator.units){
			if(unitsNotInGeneratorList.includes(unit.node)){
				unitsNotInGeneratorList.splice(unitsNotInGeneratorList.indexOf(unit.node), 1);
			} else {
				unitsNotInDispatchList.push(unit.node);
			}
		}
	}

	return {
		unitsNotInDispatchList: unitsNotInDispatchList,
		unitsNotInGeneratorList: unitsNotInGeneratorList
	};
}