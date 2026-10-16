import { GeneratorDefinition } from "../../clients/generators";
import { RealTimeDispatch } from "../../models/realTimeDispatch";

// output within this fraction of a unit's capacity is ignored. some units sit just above theirs (e.g. solar farms a
// fraction of a MW over), and RTD has rounding noise (e.g. Roxburgh at 120.001MW for hours on end)
const TOLERANCE = 0.01;

export type UnitOverCapacity = {
    node: string;
    name: string;
    mw: number;
    capacity: number;
}

// units generating more than their capacity in the generator list, which usually means the capacity needs updating
export function findUnitsOverCapacity(dispatch: RealTimeDispatch[], generators: GeneratorDefinition[]): UnitOverCapacity[] {
    const units = new Map(generators.flatMap(generator => generator.units.map(unit => [unit.node, unit] as const)));

    return dispatch.flatMap(item => {
        const unit = units.get(item.PointOfConnectionCode);
        // battery charging nodes have a negative capacity, and units without a known capacity have 0
        if (!unit || unit.capacity <= 0 || item.SPDGenerationMegawatt <= unit.capacity * (1 + TOLERANCE)) {
            return [];
        }
        return [{ node: unit.node, name: unit.name, mw: item.SPDGenerationMegawatt, capacity: unit.capacity }];
    });
}

export function formatUnitsOverCapacityMessage(units: UnitOverCapacity[]): string {
    return units
        .map(unit => `⚠️ *${unit.name}* (\`${unit.node}\`) is generating *${formatMw(unit.mw)}*, above its capacity of ${formatMw(unit.capacity)} in the generator list`)
        .join("\n");
}

function formatMw(mw: number): string {
    return mw.toLocaleString("en-NZ", { maximumFractionDigits: 1 }) + " MW";
}
