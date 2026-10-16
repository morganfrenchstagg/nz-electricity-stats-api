import { GeneratorDefinition, UnitDefinition } from "../../clients/generators";
import { PocpOutage } from "../../models/pocpOutage";

export function mapOutagesByUnit(outages: PocpOutage[], generatorDefinitions: GeneratorDefinition[]) {
    const unitOutages: Record<string, PocpOutage[]> = {};

    const allUnits = generatorDefinitions.flatMap(generator => generator.units);

    // a unit that moved node is listed twice with the same unit code: decommissioned at its old node and in service at
    // its new one. each match below prefers an in-service unit so the outage lands on the node the live view looks up,
    // falling back to any unit so outages on retired plant (e.g. TCC) still map where they did rather than onto a looser match
    const now = Date.now();
    const isInService = (unit: UnitDefinition) =>
        (unit.commissioned === undefined || Date.parse(unit.commissioned) <= now) &&
        (unit.decomissioned === undefined || Date.parse(unit.decomissioned) > now);
    const findUnit = (units: UnitDefinition[], matches: (unit: UnitDefinition) => boolean) =>
        units.find(unit => matches(unit) && isInService(unit)) ?? units.find(matches);

    for (const outage of outages) {
        // matches based on an 'exact' (translated) match of the outage block to the unit code
        const matchingUnit = findUnit(allUnits, unit => unit.unitCode.toLowerCase() === outage.outageBlock.split('_').join('').toLowerCase());
        if (matchingUnit) {
            unitOutages[matchingUnit.node] = [...(unitOutages[matchingUnit.node] || []), outage];
            continue;
        }

        // matches based on the start of the unit code to the start of the outage block
        const matchingUnit2 = findUnit(allUnits, unit => unit.unitCode.startsWith(outage.outageBlock.split('_')[0]));
        if (matchingUnit2) {
            unitOutages[matchingUnit2.node] = [...(unitOutages[matchingUnit2.node] || []), outage];
            continue;
        }

        // matches based on the generator site/alias matching the start of the outage block
        const matchingGenerator = generatorDefinitions.find(generator => generator.site?.toLowerCase() === outage.outageBlock.split('_')[0].toLowerCase() || generator.alias?.toLowerCase() === outage.outageBlock.split('_')[0].toLowerCase());
        if (matchingGenerator) {
            const generatorUnit = findUnit(matchingGenerator.units, () => true)!;
            unitOutages[generatorUnit.node] = [...(unitOutages[generatorUnit.node] || []), outage];
            continue;
        }

        // matches based on the start of the outage block naming the RTD node's whole substation ('ARG') or bus ('KAW2201').
        // a partial prefix isn't enough: Whareroa's 'ST' (steam turbine) block would otherwise land on Cobb's 'STK0661 COB0'
        const matchingUnit3 = findUnit(allUnits, unit => {
            const bus = unit.node.toLowerCase().split(' ')[0];
            const blockStart = outage.outageBlock.split('_')[0].toLowerCase();
            return blockStart === bus || blockStart === bus.replace(/\d+$/, '');
        });
        if (matchingUnit3) {
            unitOutages[matchingUnit3.node] = [...(unitOutages[matchingUnit3.node] || []), outage];
            continue;
        }
    }
    return unitOutages;
}
