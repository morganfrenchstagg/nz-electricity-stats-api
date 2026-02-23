import { getGenerators } from "./generators";

export const checkForMissingUnits = async (dispatchList: string[]) => {
	const generators = await getGenerators();

	const unitsNotInDispatchList = [];

	for(const generator of generators){
		for(const unit of generator.units){
			if(!dispatchList.includes(unit.node)){
				unitsNotInDispatchList.push(unit.node);
			}
		}
	}

	return {
		unitsNotInDispatchList: unitsNotInDispatchList
	};
}