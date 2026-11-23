import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, mapWithConcurrency, round, runTool, ToolInputError } from "../api";
import { parseEnd, parseStart, todayInNz } from "../dates";
import { DispatchDays, resolvePriceNode, toBucket } from "../dispatchDay";
import { getGxp } from "../nodes";
import { checkSize } from "../table";
import { DISPATCH_AGGREGATES_START, getDatesBetween } from "../../services/dispatchAggregation/dispatchAggregation";

// each day is about 1MB of dispatch, so a month is as much as a single call reads
const MAX_DAYS = 31;

// EMI's first daily dispatch file starts at 9:35am on 10 September 2020, so the API has that day from the metered
// generation, without prices
const FIRST_PRICE_DATE = DISPATCH_AGGREGATES_START;

// the North and South Islands' reference nodes, which prices are usually quoted at
const DEFAULT_NODES = ["OTA2201", "BEN2201"];

const RESOLUTIONS = { "5min": 5, "30min": 30, "60min": 60, "daily": 24 * 60 } as const;
type Resolution = keyof typeof RESOLUTIONS;

export type PricesArgs = {
	nodes?: string[];
	from?: string;
	to?: string;
	resolution?: Resolution;
};

type Sample = { time: string; price: number };

export function registerPricesTool(server: McpServer, api: ApiClient) {
	server.registerTool("get_prices", {
		title: "Wholesale prices",
		description: "Wholesale spot prices ($/MWh) at grid nodes from the 5-minute dispatch, for up to 31 days at a time, with each node's "
			+ "mean, median, percentiles and when its highest and lowest prices were. Prices are only available from 11 September 2020. "
			+ "Use it for questions like 'What was the average price at Otahuhu last week?', 'When did prices spike yesterday?' or "
			+ "'How far apart were North and South Island prices in October?'. For more than a month, call it once per month.",
		inputSchema: {
			nodes: z.array(z.string()).max(10).optional()
				.describe("Grid nodes by code (e.g. OTA2201), site code (e.g. HAY) or substation name (e.g. Haywards, Otahuhu). A site or name "
					+ "picks its highest voltage bus. Defaults to OTA2201 (Ōtāhuhu) and BEN2201 (Benmore), the usual North and South Island reference nodes"),
			from: z.string().optional().describe("First day, YYYY-MM-DD. Defaults to today (NZ time)"),
			to: z.string().optional().describe("Last day, YYYY-MM-DD. Defaults to from"),
			resolution: z.enum(["5min", "30min", "60min", "daily"]).optional()
				.describe("The rows' resolution, each the mean of its 5-minute prices. Defaults to daily for more than one day, otherwise 30min"),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => runTool(() => getPrices(api, args)));
}

export async function getPrices(api: ApiClient, args: PricesArgs) {
	const from = args.from ? parseStart(args.from) : todayInNz();
	const to = args.to ? parseEnd(args.to) : args.from ? parseEnd(args.from) : from;
	const dates = getDatesBetween(from, to);
	if (dates.length === 0) {
		throw new ToolInputError(`from (${from}) is after to (${to})`);
	}
	if (dates.length > MAX_DAYS) {
		throw new ToolInputError(`That's ${dates.length} days, more than the ${MAX_DAYS} a call can read. Split it into months`);
	}
	if (to < FIRST_PRICE_DATE) {
		throw new ToolInputError("Prices are only available from 11 September 2020, the first full day of EMI's dispatch data");
	}
	const resolution = args.resolution ?? (dates.length > 1 ? "daily" : "30min");
	const requested = args.nodes?.length ? args.nodes : DEFAULT_NODES;

	// the nodes each request's prices came from, which can differ between days (e.g. the live dispatch has every node, but
	// EMI's daily files only the ones with generation or load)
	const used = new Map(requested.map(request => [request, new Set<string>()]));
	const samples = new Map(requested.map(request => [request, [] as Sample[]]));
	const missingDates = [] as string[];
	const liveDates = [] as string[];
	const days = new DispatchDays(api, from);

	await mapWithConcurrency(dates, 3, async date => {
		const day = await days.get(date);
		if (!day) {
			missingDates.push(date);
			return;
		}
		if (day.live) {
			liveDates.push(date);
		}
		for (const request of requested) {
			const node = resolvePriceNode(request, day.series);
			const column = node ? day.series.indexOf(node) + 1 : 0;
			for (const row of column > 0 ? day.pricing : []) {
				if (row[column] !== null && row[column] !== undefined) {
					samples.get(request)!.push({ time: row[0], price: +row[column]! });
					used.get(request)!.add(node!);
				}
			}
		}
	});

	const found = requested.filter(request => samples.get(request)!.length > 0);
	if (found.length === 0) {
		throw new ToolInputError(missingDates.length === dates.length
			? `There's no dispatch between ${from} and ${to}. Prices are available from 11 September 2020 to today`
			: `No prices for ${requested.join(", ")} between ${from} and ${to}. `
				+ "Use a node code like OTA2201, a site code like OTA or a substation name like Otahuhu");
	}
	for (const request of found) {
		samples.get(request)!.sort((a, b) => a.time.localeCompare(b.time));
	}

	const isDaily = resolution === "daily";
	const columns = ["period", ...found.flatMap(request => isDaily ? [`${request} mean`, `${request} min`, `${request} max`] : [request])];
	const buckets = [...new Set(found.flatMap(request => samples.get(request)!.map(sample => toBucket(sample.time, RESOLUTIONS[resolution]))))].sort();
	checkSize(buckets.length, columns.length);

	const byBucket = new Map(found.map(request => [request, groupByBucket(samples.get(request)!, RESOLUTIONS[resolution])]));
	const rows = buckets.map(bucket => [bucket, ...found.flatMap(request => {
		const prices = byBucket.get(request)!.get(bucket);
		if (!prices) {
			return isDaily ? [null, null, null] : [null];
		}
		const mean = round(average(prices), 2);
		return isDaily ? [mean, Math.min(...prices), Math.max(...prices)] : [mean];
	})]);

	return {
		unit: "$/MWh",
		from,
		to,
		resolution,
		nodes: found.map(request => {
			const nodesUsed = [...used.get(request)!].sort();
			return { requested: request, nodesUsed, substation: getGxp(nodesUsed[0]).substation, island: getGxp(nodesUsed[0]).island };
		}),
		...(found.length < requested.length ? { notFound: requested.filter(request => !found.includes(request)) } : {}),
		columns,
		rows,
		summary: Object.fromEntries(found.map(request => [request, summarise(samples.get(request)!)])),
		...(missingDates.length > 0 ? { missingDates: missingDates.sort() } : {}),
		...(liveDates.length > 0 ? { liveDates: liveDates.sort() } : {}),
		notes: [
			"Each row is the mean of its 5-minute dispatch prices, which are the real-time prices, before final pricing.",
			"EMI's daily dispatch files leave out nodes with no generation or load, so where a node isn't in them its prices are from "
				+ "the nearest node at the same substation (see nodesUsed), e.g. OTA0221 for OTA2201. They're within a few percent of each other.",
			...(from < FIRST_PRICE_DATE ? ["Prices are only available from 11 September 2020, the first full day of EMI's dispatch data."] : []),
			...(liveDates.length > 0 ? ["The live dates are from the live dispatch, as EMI hasn't published them yet, and today only so far."] : []),
		],
	};
}

function groupByBucket(samples: Sample[], minutes: number): Map<string, number[]> {
	const buckets = new Map<string, number[]>();
	for (const sample of samples) {
		const bucket = toBucket(sample.time, minutes);
		if (!buckets.has(bucket)) {
			buckets.set(bucket, []);
		}
		buckets.get(bucket)!.push(sample.price);
	}
	return buckets;
}

function summarise(samples: Sample[]) {
	if (samples.length === 0) {
		return { intervals: 0 };
	}
	const prices = samples.map(sample => sample.price).sort((a, b) => a - b);
	const lowest = samples.reduce((min, sample) => sample.price < min.price ? sample : min);
	const highest = samples.reduce((max, sample) => sample.price > max.price ? sample : max);
	return {
		intervals: samples.length,
		mean: round(average(prices), 2),
		median: percentile(prices, 50),
		p10: percentile(prices, 10),
		p90: percentile(prices, 90),
		min: { price: lowest.price, at: lowest.time },
		max: { price: highest.price, at: highest.time },
	};
}

function average(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// nearest rank, from sorted values
function percentile(sorted: number[], percent: number): number {
	return sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)];
}
