import { getGenerators } from "../generators";
import { getSubstations } from "../substations";

export const checkForMissingUnits = async (dispatchList: string[]) => {
  const generators = await getGenerators();
  const substations = await getSubstations();

  const unitsNotInDispatchList = [];
  const unitsNotInGeneratorList = dispatchList.filter(
    (unit) => (unit as string).split(" ").length > 1,
  );

  for (const generator of generators) {
    for (const unit of generator.units) {
      if (unitsNotInGeneratorList.includes(unit.node)) {
        unitsNotInGeneratorList.splice(
          unitsNotInGeneratorList.indexOf(unit.node),
          1,
        );
      } else if (unit.active === undefined || unit.active === true) {
        unitsNotInDispatchList.push(unit.node);
      }
    }
  }

  const substationUnitsNotInDispatchList = [];
  const unitsNotInSubstationList = dispatchList.filter(
    (unit) => (unit as string).split(" ").length === 1,
  );
  for (const substation of substations) {
    if (unitsNotInSubstationList.includes(substation.siteId)) {
      unitsNotInSubstationList.splice(
        unitsNotInSubstationList.indexOf(substation.siteId),
        1,
      );
    } else {
      substationUnitsNotInDispatchList.push(substation.siteId);
    }
  }

  return {
    generation: {
      notInDispatchList: unitsNotInDispatchList,
      notInGeneratorList: unitsNotInGeneratorList,
    },
    substations: {
      notInDispatchList: substationUnitsNotInDispatchList,
      notInSubstationList: unitsNotInSubstationList,
    },
  };
};
