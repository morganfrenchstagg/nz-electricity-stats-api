import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, round, runTool, ToolInputError } from "../api";
import { parseStart, todayInNz } from "../dates";
import { DispatchDays, getIntervalMinutes, resolvePriceNode, toBucket } from "../dispatchDay";
import { groupNodes, Metric, validateGroupBy } from "../grouping";
import { DEMAND_GROUPS, DemandGroup, GENERATION_GROUPS, GenerationGroup, UnitFilter } from "../nodes";
import { DEFAULT_TOP, topSchema, unitFilterShape } from "../schemas";
import { GroupedRow, toTable } from "../table";
import { hoursInNzDay } from "../../services/dispatchAggregation/dispatchAggregation";

const RESOLUTIONS = { "5min": 5, "30min": 30, "60min": 60 } as const;

const PRICE_NODES = ["OTA2201", "BEN2201"];

export type DayProfileArgs = UnitFilter & {
	date?: string;
	metric?: Metric;
	group_by?: GenerationGroup | DemandGroup;
	resolution?: keyof typeof RESOLUTIONS;
	include_hvdc?: boolean;
	include_prices?: boolean;
	top?: number;
};

export function registerDayProfileTool(server: McpServer, api: ApiClient) {
	server.registerTool("get_day_profile", {
		title: "A day's generation or demand through the day",
		description: "A single day's generation or demand (MW) through the day, grouped by fuel, island, station and so on, with each group's "
			+ "mean, peak and lowest MW and when they were, and its energy. Optionally adds the HVDC's flows and Ōtāhuhu and Benmore prices. "
			+ "Use it for questions about within-day patterns, e.g. 'When was demand highest yesterday?', 'How much was wind generating at "
			+ "6pm on 3 July?' or 'How much did the batteries discharge during the evening peak?'. Days before 11 September 2020 are "
			+ "half-hourly metered generation without demand or prices.",
		inputSchema: {
			date: z.string().optional().describe("YYYY-MM-DD, from 1 August 1997. Defaults to today (NZ time), which is only so far"),
			metric: z.enum(["generation", "demand"]).optional()
				.describe("generation (default), or demand: what was taken from the grid, at grid exit points and by dispatchable loads and batteries charging"),
			group_by: z.enum([...new Set([...GENERATION_GROUPS, ...DEMAND_GROUPS])]).optional()
				.describe(`For generation: ${GENERATION_GROUPS.join(", ")} (default fuel). For demand: ${DEMAND_GROUPS.join(", ")} (default island)`),
			resolution: z.enum(["5min", "30min", "60min"]).optional()
				.describe("Each row is the mean MW over this long. Defaults to 30min"),
			include_hvdc: z.boolean().optional().describe("Add the MW the HVDC sent north and south"),
			include_prices: z.boolean().optional().describe("Add the mean price at Ōtāhuhu (OTA2201) and Benmore (BEN2201)"),
			top: topSchema,
			...unitFilterShape,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => runTool(() => getDayProfile(api, args)));
}

export async function getDayProfile(api: ApiClient, args: DayProfileArgs) {
	const date = args.date ? parseStart(args.date) : todayInNz();
	const metric = args.metric ?? "generation";
	const groupBy = args.group_by ?? (metric === "demand" ? "island" : "fuel");
	validateGroupBy(metric, groupBy, args);

	const day = await new DispatchDays(api, date).get(date);
	if (!day) {
		throw new ToolInputError(`There's no dispatch for ${date}. The data begins on 1997-08-01 and EMI publishes each day the day after`);
	}
	const intervalMinutes = getIntervalMinutes(day);
	const minutes = Math.max(RESOLUTIONS[args.resolution ?? "30min"], intervalMinutes);

	// each bucket's rows, summed by group, to average once they're all in
	const buckets = new Map<string, { values: Map<string, number>; rows: number }>();
	for (const [time, ...values] of day.data) {
		const bucket = buckets.get(toBucket(time, minutes)) ?? { values: new Map(), rows: 0 };
		for (const [group, value] of groupNodes(metric, groupBy, args, day.series, values).values) {
			bucket.values.set(group, (bucket.values.get(group) ?? 0) + value);
		}
		bucket.rows++;
		buckets.set(toBucket(time, minutes), bucket);
	}

	const rows: GroupedRow[] = [...buckets].map(([label, bucket]) => ({
		label,
		values: new Map([...bucket.values].map(([group, value]) => [group, value / bucket.rows])),
	}));
	const { columns, rows: tableRows } = toTable(rows, args.top ?? DEFAULT_TOP, 1);
	const summary = summarise(columns, tableRows, day.live ? day.data.length * intervalMinutes / 60 : hoursInNzDay(date));

	if (args.include_hvdc) {
		addHvdcColumns(columns, tableRows, day.hvdc.data, minutes);
	}
	if (args.include_prices) {
		addPriceColumns(columns, tableRows, day.series, day.pricing, minutes);
	}

	// EMI's daily files sometimes miss intervals, which the rows and energy are averaged over
	const expectedRows = hoursInNzDay(date) * 60 / intervalMinutes;
	const missingIntervals = day.live ? 0 : expectedRows - day.data.length;

	return {
		date,
		metric,
		unit: "MW",
		resolution: `${minutes}min`,
		groupBy,
		live: day.live,
		columns,
		rows: tableRows,
		summary,
		notes: [
			...(day.live ? ["EMI hasn't published this day yet, so it's from the live dispatch, and today only so far."] : []),
			...(intervalMinutes === 30
				? ["This day is before the dispatch data, so it's EMI's half-hourly metered generation, without demand or prices."]
				: []),
			...(missingIntervals > 0
				? [`${missingIntervals} of the day's ${expectedRows} intervals are missing from EMI's data, so rows without any are left out and the energy averages the rest.`]
				: []),
			...(args.include_hvdc && !day.hvdc.data.length ? ["There are no HVDC flows for this day yet."] : []),
		],
	};
}

// each column's mean, peak and lowest MW through the day, and its energy over the hours the day has data for
function summarise(columns: string[], rows: (string | number | null)[][], hours: number) {
	return Object.fromEntries(columns.slice(1).map((column, index) => {
		const points = rows.map(row => ({ time: row[0] as string, mw: row[index + 1] as number }));
		const mean = points.reduce((sum, point) => sum + point.mw, 0) / points.length;
		const peak = points.reduce((max, point) => point.mw > max.mw ? point : max);
		const lowest = points.reduce((min, point) => point.mw < min.mw ? point : min);
		return [column, {
			meanMW: round(mean, 1),
			peakMW: peak.mw,
			peakAt: peak.time,
			lowestMW: lowest.mw,
			lowestAt: lowest.time,
			energyGWh: round(mean * hours / 1000),
		}];
	}));
}

// em6 and EMI give the HVDC by half hour, so finer rows each get their half hour's flow
function addHvdcColumns(columns: string[], rows: (string | number | null)[][], hvdc: (string | number | null)[][], minutes: number) {
	const hvdcMinutes = Math.max(minutes, 30);
	const flows = new Map<string, { north: number; south: number; count: number }>();
	for (const [time, north, south] of hvdc) {
		const bucket = toBucket(time as string, hvdcMinutes);
		const flow = flows.get(bucket) ?? { north: 0, south: 0, count: 0 };
		// em6 gives the south flow as negative
		flows.set(bucket, { north: flow.north + Number(north ?? 0), south: flow.south + Math.abs(Number(south ?? 0)), count: flow.count + 1 });
	}

	columns.push("hvdc_north_MW", "hvdc_south_MW");
	for (const row of rows) {
		const flow = flows.get(toBucket(row[0] as string, hvdcMinutes));
		row.push(flow ? round(flow.north / flow.count, 1) : null, flow ? round(flow.south / flow.count, 1) : null);
	}
}

function addPriceColumns(columns: string[], rows: (string | number | null)[][], series: string[], pricing: (string | number | null)[][], minutes: number) {
	for (const request of PRICE_NODES) {
		const node = resolvePriceNode(request, series);
		const column = node ? series.indexOf(node) + 1 : 0;
		const prices = new Map<string, number[]>();
		for (const row of column > 0 ? pricing : []) {
			if (row[column] !== null) {
				const bucket = toBucket(row[0] as string, minutes);
				prices.set(bucket, [...prices.get(bucket) ?? [], Number(row[column])]);
			}
		}

		columns.push(`${request}_$/MWh${node && node !== request ? ` (from ${node})` : ""}`);
		for (const row of rows) {
			const bucketPrices = prices.get(row[0] as string);
			row.push(bucketPrices ? round(bucketPrices.reduce((sum, price) => sum + price, 0) / bucketPrices.length, 2) : null);
		}
	}
}
