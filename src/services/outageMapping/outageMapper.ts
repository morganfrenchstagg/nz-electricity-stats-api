import { GeneratorDefinition } from "../../clients/generators";
import { PocpOutage } from "../../models/pocpOutage";

export function mapOutagesByUnit(outages: PocpOutage[], generatorDefinitions: GeneratorDefinition[]) {
    const unitOutages: Record<string, PocpOutage[]> = {};

    const allUnits = generatorDefinitions.flatMap(generator => generator.units);

    for (const outage of outages) {
        // matches based on an 'exact' (translated) match of the outage block to the unit code
        const matchingUnit = allUnits.find(unit => unit.unitCode.toLowerCase() === outage.outageBlock.split('_').join('').toLowerCase());
        if (matchingUnit) {
            unitOutages[matchingUnit.node] = [...(unitOutages[matchingUnit.node] || []), outage];
            continue;
        }

        // matches based on the start of the unit code to the start of the outage block
        const matchingUnit2 = allUnits.find(unit => unit.unitCode.startsWith(outage.outageBlock.split('_')[0]));
        if (matchingUnit2) {
            unitOutages[matchingUnit2.node] = [...(unitOutages[matchingUnit2.node] || []), outage];
            continue;
        }

        // matches based on the generator site/alias matching the start of the outage block
        const matchingGenerator = generatorDefinitions.find(generator => generator.site?.toLowerCase() === outage.outageBlock.split('_')[0].toLowerCase() || generator.alias?.toLowerCase() === outage.outageBlock.split('_')[0].toLowerCase());
        if (matchingGenerator) {
            unitOutages[matchingGenerator.units[0].node] = [...(unitOutages[matchingGenerator.units[0].node] || []), outage];
            continue;
        }

        // matches based on the start of the RTD node matching the start of the outage block
        const matchingUnit3 = allUnits.find(unit => unit.node.toLowerCase().startsWith(outage.outageBlock.split('_')[0].toLowerCase()));
        if (matchingUnit3) {
            unitOutages[matchingUnit3.node] = [...(unitOutages[matchingUnit3.node] || []), outage];
            continue;
        }
    }
    return unitOutages;
}