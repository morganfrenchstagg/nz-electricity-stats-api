import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, mapWithConcurrency, round, runTool, ToolInputError } from "../api";
import { addDays, parseEnd, parseStart, todayInNz, monthsBetween } from "../dates";
import { DEMAND_GROUPS, DemandGroup, GENERATION_GROUPS, GenerationGroup, UnitFilter } from "../nodes";
import { Grouped, groupNodes, validateGroupBy } from "../grouping";
import { DEFAULT_TOP, topSchema, unitFilterShape } from "../schemas";
import { GroupedRow, toTable } from "../table";
import { DISPATCH_AGGREGATES_START, getIsoWeek, getMonthBounds } from "../../services/dispatchAggregation/dispatchAggregation";

type Resolution = "annual" | "monthly" | "weekly" | "daily";
type Metric = "generation" | "demand" | "hvdc";

type AggregatesResponse = {
	series: string[];
	data: (string | number)[][];
	hvdc: { series: string[]; data: (string | number)[][] };
};

// the aggregate files a request can read, e.g. about 3 years of daily totals
const MAX_FILES = 40;

// metered generation goes back to August 1997
const FIRST_DATE = "1997-08-01";

export type EnergyArgs = UnitFilter & {
	metric?: Metric;
	resolution?: Resolution;
	from?: string;
	to?: string;
	group_by?: GenerationGroup | DemandGroup;
	top?: number;
};

export function registerEnergyTool(server: McpServer, api: ApiClient) {
	server.registerTool("get_energy", {
		title: "Energy by period",
		description: "Electricity generated (or taken from the grid, or sent over the HVDC) in GWh by year, month, ISO week or day, "
			+ "from August 1997 to today, grouped by fuel, island, operator, station and so on. Use it for totals, trends, shares and "
			+ "comparisons between periods, e.g. 'How much did wind generate in 2025?', 'What share of generation was renewable each "
			+ "year since 2000?', 'Which stations generated the most last month?' or 'How did South Island demand compare to last winter?'. "
			+ "Periods are included when they start within from and to. The latest periods can be incomplete (see incompletePeriods).",
		inputSchema: {
			metric: z.enum(["generation", "demand", "hvdc"]).optional()
				.describe("generation (default): what generating units sent to the grid. demand: what was taken from the grid, at grid exit points "
					+ "(net of generation embedded behind them) and by dispatchable loads and batteries charging. "
					+ "hvdc: what the HVDC link sent north and south"),
			resolution: z.enum(["annual", "monthly", "weekly", "daily"]).optional()
				.describe("Defaults to monthly. weekly is ISO weeks (Monday to Sunday), labelled by their Monday"),
			from: z.string().optional()
				.describe("First period, as YYYY, YYYY-MM or YYYY-MM-DD. Defaults to all years for annual, the last 12 months for monthly, "
					+ "13 weeks for weekly and 31 days for daily"),
			to: z.string().optional().describe("Last period, as YYYY, YYYY-MM or YYYY-MM-DD. Defaults to today"),
			group_by: z.enum([...new Set([...GENERATION_GROUPS, ...DEMAND_GROUPS])]).optional()
				.describe(`How to split the energy. For generation: ${GENERATION_GROUPS.join(", ")} (default fuel). `
					+ `For demand: ${DEMAND_GROUPS.join(", ")} (default island). Ignored for hvdc`),
			top: topSchema,
			...unitFilterShape,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => runTool(() => getEnergy(api, args)));
}

export async function getEnergy(api: ApiClient, args: EnergyArgs) {
	const metric = args.metric ?? "generation";
	const resolution = args.resolution ?? "monthly";
	const groupBy = args.group_by ?? (metric === "demand" ? "island" : "fuel");
	if (metric !== "hvdc") {
		validateGroupBy(metric, groupBy, args);
	}

	const today = todayInNz();
	const to = args.to ? parseEnd(args.to) : today;
	const from = args.from ? parseStart(args.from) : getDefaultFrom(resolution, to);
	if (from > to) {
		throw new ToolInputError(`from (${from}) is after to (${to})`);
	}

	const paths = getAggregatePaths(resolution, from < FIRST_DATE ? FIRST_DATE : from, to > today ? today : to);
	if (paths.length > MAX_FILES) {
		throw new ToolInputError(`That range needs ${paths.length} of the API's ${resolution} files, more than ${MAX_FILES}. Use a shorter range or a coarser resolution`);
	}

	const [latest, responses] = await Promise.all([
		api.get<{ latestDate: string | null; latestHvdcDate?: string | null }>("/v1/dispatch/aggregates"),
		mapWithConcurrency(paths, 4, path => api.get<AggregatesResponse>(path)),
	]);
	// the HVDC's days after EMI's latest month come from em6, which only has some of them (see getNotes)
	const latestDate = (metric === "hvdc" ? latest?.latestHvdcDate : latest?.latestDate) ?? null;

	const rows: (GroupedRow & { start: string; renewable?: number })[] = [];
	for (const response of responses) {
		if (!response) {
			continue;
		}
		const source = metric === "hvdc" ? response.hvdc : response;
		for (const [start, ...values] of source.data as [string, ...number[]][]) {
			if (start >= from && start <= to) {
				rows.push({
					start,
					label: toLabel(resolution, start),
					...groupRow(metric, groupBy, args, source.series, values),
				});
			}
		}
	}
	rows.sort((a, b) => a.start.localeCompare(b.start));

	const table = toTable(rows, metric === "hvdc" ? 2 : args.top ?? DEFAULT_TOP);

	// the share of generation from renewables, unless the fuels have been filtered (where it'd mean something else)
	const showRenewableShare = metric === "generation" && !args.fuel?.length;
	if (showRenewableShare) {
		table.columns.push("renewable_share_%");
		table.rows.forEach((row, index) => {
			const total = [...rows[index].values.values()].reduce((sum, value) => sum + value, 0);
			row.push(total === 0 ? null : round(rows[index].renewable! / total * 100, 1));
		});
	}

	const incompletePeriods = rows
		.filter(row => latestDate === null || getPeriodEnd(resolution, row.start) > latestDate)
		.map(row => row.label);

	return {
		metric,
		unit: "GWh",
		resolution,
		groupBy: metric === "hvdc" ? undefined : groupBy,
		from,
		to,
		...table,
		...(showRenewableShare && table.total !== 0
			? { renewableSharePercent: round(rows.reduce((sum, row) => sum + row.renewable!, 0) / table.total * 100, 1) }
			: {}),
		latestCompleteDate: latestDate,
		incompletePeriods,
		notes: getNotes(metric, from, incompletePeriods.length > 0, latestDate, rows.length > 0),
	};
}

// in GWh, from the API's MWh
function groupRow(metric: Metric, groupBy: string, filter: UnitFilter, series: string[], values: number[]): Grouped {
	if (metric === "hvdc") {
		return {
			values: new Map(series.map((direction, index) => [direction === "northFlow" ? "north" : "south", values[index] / 1000])),
			renewable: 0,
		};
	}
	const grouped = groupNodes(metric, groupBy, filter, series, values);
	return {
		values: new Map([...grouped.values].map(([group, mwh]) => [group, mwh / 1000])),
		renewable: grouped.renewable / 1000,
	};
}

function getDefaultFrom(resolution: Resolution, to: string): string {
	switch (resolution) {
		case "annual": return FIRST_DATE;
		case "monthly": {
			const [year, month] = to.split("-").map(Number);
			return new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10);
		}
		case "weekly": return getIsoWeek(addDays(to, -12 * 7)).from;
		case "daily": return addDays(to, -30);
	}
}

function getAggregatePaths(resolution: Resolution, from: string, to: string): string[] {
	const base = "/v1/dispatch/aggregates";
	if (from > to) {
		return [];
	}
	switch (resolution) {
		case "annual":
			return [`${base}/annual`];
		case "monthly":
			return years(+from.slice(0, 4), +to.slice(0, 4)).map(year => `${base}/${year}/monthly`);
		case "weekly":
			// weekly files are by ISO week year, so the first can start in the year before
			return years(+getIsoWeek(from).year, +getIsoWeek(to).year).map(year => `${base}/${year}/weekly`);
		case "daily":
			return monthsBetween(from, to).map(month => `${base}/${month.slice(0, 4)}/${month.slice(5)}`);
	}
}

function years(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function toLabel(resolution: Resolution, start: string): string {
	switch (resolution) {
		case "annual": return start.slice(0, 4);
		case "monthly": return start.slice(0, 7);
		default: return start;
	}
}

function getPeriodEnd(resolution: Resolution, start: string): string {
	switch (resolution) {
		case "annual": return `${start.slice(0, 4)}-12-31`;
		case "monthly": return getMonthBounds(start.slice(0, 7)).to;
		case "weekly": return addDays(start, 6);
		case "daily": return start;
	}
}

function getNotes(metric: Metric, from: string, hasIncompletePeriods: boolean, latestDate: string | null, hasRows: boolean): string[] {
	const notes = hasRows ? [] : ["There's no data for this range. It begins in August 1997."];
	if (metric === "generation") {
		notes.push("Generation is what the grid's dispatched generating units sent out, so it leaves out rooftop solar and most small "
			+ "generation embedded in local networks. A battery's charging is demand, though where it charges and discharges at the same "
			+ "node its generation in a period is net of its charging.");
		if (from < DISPATCH_AGGREGATES_START) {
			notes.push(`Before ${DISPATCH_AGGREGATES_START} generation comes from EMI's half-hourly metered generation rather than the 5-minute `
				+ "dispatch. Metered data combines some units (e.g. Huntly's Rankine units before 2000), so the unit group has combined units then.");
		}
	}
	if (metric === "demand") {
		notes.push("Demand is what was taken from the grid: at grid exit points, net of any generation embedded behind them, and by "
			+ "dispatchable loads and batteries charging. It includes large direct-connected users like the Tiwai Point smelter, and "
			+ "generation less demand is the grid's losses (about 3-5%).");
		if (from < DISPATCH_AGGREGATES_START) {
			notes.push(`Before ${DISPATCH_AGGREGATES_START} demand comes from EMI's metered grid export and import at each point of connection. `
				+ "Grid import begins in October 2000, so before then it's only what was taken from the grid, without what was injected.");
		}
	}
	if (metric === "hvdc") {
		notes.push("Each way is what was sent into the link (at Benmore going north and Haywards going south), a few percent more than "
			+ "arrived after losses. Since 2013 it can flow both ways within a half hour, so both can be above 0.");
		if (hasIncompletePeriods) {
			notes.push(`EMI publishes each month's HVDC flows about 10 days after it ends, so the days after ${latestDate ?? "its latest month"} `
				+ "come from em6, which has only been kept since late October 2026. The incomplete periods are missing the days before then, "
				+ "so they're too low until EMI publishes them.");
		}
	}
	if (from < "1997-09-01") {
		notes.push("Data begins in August 1997, so 1997 is a partial year.");
	}
	if (hasIncompletePeriods && metric !== "hvdc") {
		notes.push(`The incomplete periods are still receiving data. Days after ${latestDate ?? "the latest daily file"} come from the `
			+ "live 5-minute dispatch, and today only so far.");
	}
	return notes;
}
