import { round, ToolInputError } from "./api";

// the most cells a tool returns, so a result doesn't flood the agent's context
const MAX_CELLS = 4000;

export type GroupedRow = {
	label: string;
	values: Map<string, number>;
};

export type Table = {
	columns: string[];
	rows: (string | number | null)[][];
	// each group's total over every row, and its share of the total (%)
	totals: Record<string, { value: number; share: number }>;
	total: number;
};

// a row per period and a column per group, with the groups in order of their total. groups after the first top are
// summed into one "Other" column
export function toTable(rows: GroupedRow[], top: number, decimals = 3): Table {
	const groupTotals = new Map<string, number>();
	for (const row of rows) {
		for (const [group, value] of row.values) {
			groupTotals.set(group, (groupTotals.get(group) ?? 0) + value);
		}
	}

	const ordered = [...groupTotals.keys()].sort((a, b) => Math.abs(groupTotals.get(b)!) - Math.abs(groupTotals.get(a)!));
	const kept = ordered.slice(0, top);
	const other = ordered.slice(top);
	const otherName = `Other (${other.length} more)`;
	const groups = other.length > 0 ? [...kept, otherName] : kept;
	const valueOf = (values: Map<string, number>, group: string) => group === otherName
		? other.reduce((sum, name) => sum + (values.get(name) ?? 0), 0)
		: values.get(group) ?? 0;

	const hasTotalColumn = groups.length > 1;
	const columns = ["period", ...groups, ...(hasTotalColumn ? ["total"] : [])];
	checkSize(rows.length, columns.length);

	const total = [...groupTotals.values()].reduce((sum, value) => sum + value, 0);
	const totalsByGroup = new Map(groups.map(group => [group, group === otherName
		? other.reduce((sum, name) => sum + groupTotals.get(name)!, 0)
		: groupTotals.get(group)!]));

	return {
		columns,
		rows: rows.map(row => {
			const values = groups.map(group => round(valueOf(row.values, group), decimals));
			const rowTotal = [...row.values.values()].reduce((sum, value) => sum + value, 0);
			return [row.label, ...values, ...(hasTotalColumn ? [round(rowTotal, decimals)] : [])];
		}),
		totals: Object.fromEntries(groups.map(group => [group, {
			value: round(totalsByGroup.get(group)!, decimals),
			share: total === 0 ? 0 : round(totalsByGroup.get(group)! / total * 100, 1),
		}])),
		total: round(total, decimals),
	};
}

export function checkSize(rows: number, columns: number) {
	if (rows * columns > MAX_CELLS) {
		throw new ToolInputError(`That's ${rows} rows x ${columns} columns, more than the ${MAX_CELLS} cells a result can have. `
			+ "Use a shorter range, a coarser resolution, fewer groups or a smaller top");
	}
}
