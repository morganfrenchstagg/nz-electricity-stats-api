import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, round, runTool, ToolInputError } from "../api";
import { parseNzTime } from "../dates";
import { GENERATION_GROUPS, GenerationGroup, generationGroupOf, getUnit, matchesUnitFilter, UnitFilter, validateUnitFilter } from "../nodes";
import { OUTAGE_DAYS_AHEAD, OUTAGE_DAYS_BEFORE } from "../../clients/pocpApi";
import { unitFilterShape } from "../schemas";
import { getActiveOutages, Outages, toNzTime } from "./live";

// the most outages listed, so a broad request doesn't flood the agent's context
const MAX_OUTAGES = 40;

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

export type OutagesArgs = UnitFilter & {
	at?: string;
	group_by?: GenerationGroup;
	include_ended?: boolean;
};

export function registerOutagesTool(server: McpServer, api: ApiClient) {
	server.registerTool("get_outages", {
		title: "Generation outages",
		description: "Generating units' planned and unplanned outages from Transpower's Planned Outage Coordination Process (POCP), "
			+ "from about 14 days ago to 3 days ahead, with the MW each takes out and the total out at a time by fuel, station and so on. "
			+ "Use it for questions like 'Which stations are on outage?', 'How much hydro is out?' or 'When is Huntly 5 back?'. "
			+ "It has no history before that window.",
		inputSchema: {
			at: z.string().optional()
				.describe("Sum up the outages going on at this time, from 14 days ago to 3 days ahead: an ISO date and time, in NZ time "
					+ "unless it has an offset (e.g. 2026-11-07T18:00 or 2026-11-07T18:00:00+13:00), or a date (its midday in NZ). "
					+ "Defaults to now. The outages listed are the ones active or upcoming at this time"),
			group_by: z.enum(GENERATION_GROUPS).optional().describe("How to sum the MW out. Defaults to fuel"),
			include_ended: z.boolean().optional().describe("Also list the outages that had ended by then"),
			...unitFilterShape,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => runTool(() => getOutages(api, args)));
}

export async function getOutages(api: ApiClient, args: OutagesArgs, now = new Date()) {
	validateUnitFilter(args);
	const at = args.at ? parseTime(args.at) : now;
	const earliest = new Date(now.getTime() - OUTAGE_DAYS_BEFORE * ONE_DAY_IN_MS);
	const latest = new Date(now.getTime() + OUTAGE_DAYS_AHEAD * ONE_DAY_IN_MS);
	if (at < earliest || at > latest) {
		// the outages that had ended before the window, or start after it, aren't known, so a total would be too low
		throw new ToolInputError(`There are only outages from ${toNzTime(earliest)} to ${toNzTime(latest)} (${OUTAGE_DAYS_BEFORE} days ago to `
			+ `${OUTAGE_DAYS_AHEAD} days ahead), so there's no total for ${toNzTime(at)}`);
	}
	const groupBy = args.group_by ?? "fuel";
	const outages = await api.get<Outages>("/v1/outages") ?? {};

	const active = getActiveOutages(outages, at).filter(([unit]) => matchesUnitFilter(unit, args));
	const summary = new Map<string, { mw: number; outages: number }>();
	for (const [unit, mw] of active) {
		const group = generationGroupOf(unit, groupBy);
		const sum = summary.get(group) ?? { mw: 0, outages: 0 };
		summary.set(group, { mw: sum.mw + mw, outages: sum.outages + 1 });
	}

	const statusAt = (outage: Outages[string][number]) => Date.parse(outage.timeStart) > at.getTime()
		? "upcoming"
		: Date.parse(outage.timeEnd) <= at.getTime() ? "ended" : "active";
	const listed = Object.entries(outages)
		.flatMap(([node, unitOutages]) => unitOutages.map(outage => ({ unit: getUnit(node), outage, status: statusAt(outage) })))
		.filter(({ unit, status }) => matchesUnitFilter(unit, args) && (args.include_ended || status !== "ended"))
		.sort((a, b) => Date.parse(a.outage.timeStart) - Date.parse(b.outage.timeStart))
		.map(({ unit, outage, status }) => ({
			station: unit.station,
			unit: unit.unit,
			node: unit.node,
			fuel: unit.fuel,
			operator: unit.operator,
			capacityMW: unit.capacity,
			outageBlock: outage.outageBlock,
			start: outage.timeStart,
			end: outage.timeEnd,
			mwOut: outage.mwattLost,
			status,
		}));

	return {
		at: toNzTime(at),
		groupBy,
		outAt: [...summary]
			.sort(([, a], [, b]) => b.mw - a.mw)
			.map(([group, sum]) => ({ group, mwOut: round(sum.mw, 1), outages: sum.outages })),
		totalMWOut: round(active.reduce((sum, [, mw]) => sum + mw, 0), 1),
		matchingOutages: listed.length,
		outages: listed.slice(0, MAX_OUTAGES),
		notes: [
			...(listed.length > MAX_OUTAGES ? [`Only the first ${MAX_OUTAGES} outages are listed. Filter by fuel, station or operator to see the rest`] : []),
			"Times are NZ times with their offset. An outage block can cover a whole station, and outages can overlap (e.g. a station's "
				+ "and one of its units'), so the MW out can count some capacity twice.",
		],
	};
}

// a date is its midday in NZ, and a time without an offset is NZ time, as the dispatch's times are
function parseTime(input: string): Date {
	const trimmed = input.trim();
	const time = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? parseNzTime(`${trimmed}T12:00`)
		: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed) ? parseNzTime(trimmed.replace(" ", "T"))
		: Date.parse(trimmed);
	if (isNaN(time)) {
		throw new ToolInputError(`Invalid time "${input}", expected e.g. 2026-11-07T18:00, 2026-11-07T18:00:00+13:00 or 2026-11-07`);
	}
	return new Date(time);
}
