import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, round, runTool, ToolInputError } from "../api";
import { parseStart } from "../dates";
import { GENERATION_GROUPS, GenerationGroup, generationGroupOf, getUnit, matchesUnitFilter, UnitFilter, validateUnitFilter } from "../nodes";
import { DEFAULT_TOP, topSchema, unitFilterShape } from "../schemas";

type Tranche = { tranche: number; megawatts: number; price: number };

type OffersResponse = {
	date: string; // e.g. 20261105
	data: Record<string, Record<string, Tranche[]>>; // by trading period then node
	fogp: Record<string, Record<string, number>>; // the same
};

const DEFAULT_PRICE_BANDS = [0.01, 50, 100, 150, 200, 300, 500, 1000];

// EMI's offers files begin on 1 October 2019
const FIRST_OFFERS_DATE = "2019-10-01";

export type OffersArgs = UnitFilter & {
	date?: string;
	trading_periods?: string;
	group_by?: GenerationGroup;
	price_bands?: number[];
	top?: number;
};

export function registerOffersTool(server: McpServer, api: ApiClient) {
	server.registerTool("get_offers", {
		title: "Generators' energy offers",
		description: "The energy generators offered into the market on a day: how many MW at what prices, as a supply curve and by fuel, "
			+ "station and so on, averaged over the trading periods asked for, and wind and solar units' forecasts of their generation "
			+ "potential. Use it for questions about the offer stack and bidding, e.g. 'How much was offered under $100 during last "
			+ "night's peak?', 'At what prices does hydro offer?' or 'How much does Meridian offer at $0.01?'.",
		inputSchema: {
			date: z.string().optional().describe("YYYY-MM-DD or latest (the default). Offers are published about a day after"),
			trading_periods: z.string().optional()
				.describe("A trading period (1-48, or up to 50 when daylight saving ends, each half hour from midnight, e.g. 37 is 6pm-6:30pm) "
					+ "or range (e.g. 35-40). Defaults to the whole day"),
			group_by: z.enum(GENERATION_GROUPS).optional().describe("Defaults to fuel"),
			price_bands: z.array(z.number().min(0)).max(15).optional()
				.describe(`The prices ($/MWh) to count the MW offered at or below. Defaults to ${DEFAULT_PRICE_BANDS.join(", ")}`),
			top: topSchema,
			...unitFilterShape,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => runTool(() => getOffers(api, args)));
}

export async function getOffers(api: ApiClient, args: OffersArgs) {
	validateUnitFilter(args);
	const date = !args.date || args.date === "latest" ? "latest" : parseStart(args.date);
	if (date !== "latest" && date < FIRST_OFFERS_DATE) {
		throw new ToolInputError(`There are no offers for ${date}. They begin on ${FIRST_OFFERS_DATE}`);
	}
	const groupBy = args.group_by ?? "fuel";
	const bands = [...(args.price_bands ?? DEFAULT_PRICE_BANDS)].sort((a, b) => a - b);

	const offers = await api.get<OffersResponse>(`/v1/offers/${date}`);
	if (!offers) {
		throw new ToolInputError(`There are no offers for ${date}. EMI publishes each day's offers the day after`);
	}

	const offersDate = `${offers.date.slice(0, 4)}-${offers.date.slice(4, 6)}-${offers.date.slice(6)}`;
	const [first, last] = parseTradingPeriods(args.trading_periods);
	const periods = Object.keys(offers.data).filter(period => +period >= first && +period <= last);
	if (periods.length === 0) {
		throw new ToolInputError(`There are no offers in trading period${first === last ? ` ${first}` : `s ${first}-${last}`} on ${offersDate}`);
	}

	// summed over the periods, then averaged
	const groups = new Map<string, { mw: number; priceTimesMw: number; maxPrice: number; atOrBelow: number[] }>();
	const curve = bands.map(() => 0);
	const forecasts = new Map<string, number>();
	for (const period of periods) {
		for (const [node, tranches] of Object.entries(offers.data[period])) {
			const unit = getUnit(node);
			if (!matchesUnitFilter(unit, args)) {
				continue;
			}
			const name = generationGroupOf(unit, groupBy);
			const group = groups.get(name) ?? { mw: 0, priceTimesMw: 0, maxPrice: 0, atOrBelow: bands.map(() => 0) };
			for (const tranche of tranches) {
				group.mw += tranche.megawatts;
				group.priceTimesMw += tranche.price * tranche.megawatts;
				group.maxPrice = Math.max(group.maxPrice, tranche.price);
				bands.forEach((band, index) => {
					if (tranche.price <= band) {
						group.atOrBelow[index] += tranche.megawatts;
						curve[index] += tranche.megawatts;
					}
				});
			}
			groups.set(name, group);
		}
		for (const [node, mw] of Object.entries(offers.fogp[period] ?? {})) {
			const unit = getUnit(node);
			if (matchesUnitFilter(unit, args)) {
				const name = generationGroupOf(unit, groupBy);
				forecasts.set(name, (forecasts.get(name) ?? 0) + mw);
			}
		}
	}

	const perPeriod = (mw: number) => round(mw / periods.length, 1);
	const totalMw = [...groups.values()].reduce((sum, group) => sum + group.mw, 0);
	const ordered = [...groups].sort(([, a], [, b]) => b.mw - a.mw);
	const top = args.top ?? DEFAULT_TOP;

	return {
		date: offersDate,
		tradingPeriods: { first: Math.min(...periods.map(Number)), last: Math.max(...periods.map(Number)), count: periods.length },
		unit: "MW, the average over the trading periods",
		groupBy,
		offeredMW: perPeriod(totalMw),
		supplyCurve: bands.map((band, index) => ({ atOrBelowPrice: band, mw: perPeriod(curve[index]) })),
		groups: {
			columns: ["group", "offered_MW", "mw_weighted_mean_price", "highest_price", ...bands.map(band => `at_or_below_$${band}`)],
			rows: ordered.slice(0, top).map(([name, group]) => [
				name,
				perPeriod(group.mw),
				group.mw === 0 ? null : round(group.priceTimesMw / group.mw, 2),
				group.maxPrice,
				...group.atOrBelow.map(perPeriod),
			]),
			...(ordered.length > top ? { note: `Only the top ${top} of ${ordered.length} groups are listed` } : {}),
		},
		...(forecasts.size > 0 ? {
			generationPotentialForecastMW: Object.fromEntries([...forecasts].sort(([, a], [, b]) => b - a).slice(0, top).map(([name, mw]) => [name, perPeriod(mw)])),
		} : {}),
		notes: [
			"These are the energy offers' tranches as finally offered for each trading period. Only tranches offering more than 0 MW are included.",
			"A unit's tranches can add up to more than it can generate (e.g. wind offered above its forecast). The generation potential "
				+ "forecasts are what intermittent (wind and some solar) units forecast with their offers, only from 24 October 2019.",
			"Prices are in $/MWh, and $0.01 or less is effectively offering to generate whatever the price.",
		],
	};
}

function parseTradingPeriods(input: string | undefined): [number, number] {
	if (!input) {
		return [1, 50];
	}
	const match = /^\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*$/.exec(input);
	const [first, last] = match ? [+match[1], +(match[2] ?? match[1])] : [0, 0];
	if (!match || first < 1 || last > 50 || first > last) {
		throw new ToolInputError(`Invalid trading_periods "${input}", expected a period from 1 to 50 (e.g. 37) or a range (e.g. 35-40)`);
	}
	return [first, last];
}
