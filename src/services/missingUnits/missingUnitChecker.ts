import { getGenerators, UnitDefinition } from "../../clients/generators";
import { getSubstations } from "../../clients/substations";

const isDecommissioned = (unit: UnitDefinition) =>
  unit.decomissioned !== undefined && Date.parse(unit.decomissioned) <= Date.now();

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
      } else if (!isDecommissioned(unit)) {
        unitsNotInDispatchList.push(unit.node);
      }
    }
  }

  const substationUnitsNotInDispatchList = [];
  const unitsNotInSubstationList = dispatchList.filter((unit) => (unit as string).split(" ").length === 1);

  for (const substation of substations) {
    const units = unitsNotInSubstationList.filter((unit) => unit.substring(0, 3) === substation.siteId);
    for (const unit of units) {
      unitsNotInSubstationList.splice(unitsNotInSubstationList.indexOf(unit), 1);
    }

    if (units.length === 0) {
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
