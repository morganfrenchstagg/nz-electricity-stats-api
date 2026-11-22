import { ToolInputError } from "./api";
import {
	DEMAND_GROUPS, DemandGroup, demandGroupOf, GENERATION_GROUPS, GenerationGroup, generationGroupOf, getGxp, getUnit, isUnitNode,
	matchesUnitFilter, RENEWABLE_FUELS, UnitFilter, validateUnitFilter
} from "./nodes";

export type Metric = "generation" | "demand";

export type Grouped = {
	values: Map<string, number>;
	// the part of the generation from renewable fuels
	renewable: number;
};

export function validateGroupBy(metric: Metric, groupBy: string, filter: UnitFilter) {
	if (metric === "generation") {
		if (!(GENERATION_GROUPS as readonly string[]).includes(groupBy)) {
			throw new ToolInputError(`group_by for generation must be one of ${GENERATION_GROUPS.join(", ")}`);
		}
		validateUnitFilter(filter);
	}
	if (metric === "demand") {
		if (!(DEMAND_GROUPS as readonly string[]).includes(groupBy)) {
			throw new ToolInputError(`group_by for demand must be one of ${DEMAND_GROUPS.join(", ")}`);
		}
		if (filter.fuel?.length || filter.operator?.length || filter.station?.length) {
			throw new ToolInputError("Demand can only be filtered by island, as fuel, operator and station are for generation");
		}
	}
}

// sums each node's net value (MW or MWh) into its group. a unit's node is generation while it's positive, and while it's
// negative its load (e.g. a battery charging, or a dispatchable load like a mill) is demand, along with what's taken at
// grid exit points. so generation less demand is the grid's losses
export function groupNodes(metric: Metric, groupBy: string, filter: UnitFilter, series: string[], values: number[]): Grouped {
	const grouped = new Map<string, number>();
	const add = (group: string, value: number) => grouped.set(group, (grouped.get(group) ?? 0) + value);
	let renewable = 0;

	series.forEach((node, index) => {
		const value = +values[index];
		const isUnit = isUnitNode(node);
		if (metric === "generation" && isUnit && value > 0) {
			const unit = getUnit(node);
			if (matchesUnitFilter(unit, filter)) {
				add(generationGroupOf(unit, groupBy as GenerationGroup), value);
				renewable += RENEWABLE_FUELS.has(unit.fuel) ? value : 0;
			}
		} else if (metric === "demand" && (!isUnit || value < 0) && value !== 0) {
			const gxp = getGxp(node);
			if (!filter.island || gxp.island === filter.island) {
				add(demandGroupOf(gxp, groupBy as DemandGroup), -value);
			}
		}
	});

	return { values: grouped, renewable };
}
