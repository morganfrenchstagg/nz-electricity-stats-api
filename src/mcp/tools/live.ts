import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, round, runTool } from "../api";
import { DispatchDay, resolvePriceNode } from "../dispatchDay";
import { groupNodes } from "../grouping";
import {
  GENERATION_GROUPS,
  GenerationGroup,
  generationGroupOf,
  getAllUnits,
  getGxp,
  getUnit,
  isUnitNode,
  matchesUnitFilter,
  UnitFilter,
  UnitInfo,
  validateUnitFilter,
} from "../nodes";
import { DEFAULT_TOP, topSchema, unitFilterShape } from "../schemas";
import { toTable } from "../table";

export type Outages = Record<
  string,
  { outageBlock: string; timeStart: string; timeEnd: string; mwattLost: number }[]
>;

export type LiveArgs = UnitFilter & {
  group_by?: GenerationGroup;
  top?: number;
};

// how far back to look for the latest interval, as the live dispatch can be a few intervals behind when EMI is slow
const LOOKBACK_MINUTES = 60;

export function registerLiveTool(server: McpServer, api: ApiClient) {
  server.registerTool(
    "get_current_state",
    {
      title: "The grid right now",
      description:
        "The latest 5-minute dispatch: what each fuel (or island, operator, station) is generating against the capacity in " +
        "service and the capacity out for outages, the renewable share, demand by island, the HVDC's flows and " +
        "limits, and prices at Ōtāhuhu, Benmore and the cheapest and most expensive nodes. Use it for 'right now' questions, e.g. " +
        "'What's the generation mix right now?' or 'How much wind is generating?'.",
      inputSchema: {
        group_by: z
          .enum(GENERATION_GROUPS)
          .optional()
          .describe("How to split the generation. Defaults to fuel"),
        top: topSchema,
        ...unitFilterShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(() => getCurrentState(api, args)),
  );
}

export async function getCurrentState(api: ApiClient, args: LiveArgs, now = new Date()) {
  validateUnitFilter(args);
  const groupBy = args.group_by ?? "fuel";
  const [recent, outages] = await Promise.all([
    api.get<DispatchDay>(
      `/v1/dispatch/recent?since=${toNzTime(new Date(now.getTime() - LOOKBACK_MINUTES * 60000))}`,
    ),
    api.get<Outages>("/v1/outages"),
  ]);
  // when the live dispatch is behind, the whole of it, for its latest interval
  const dispatch = recent?.data.length ? recent : await api.get<DispatchDay>("/v1/dispatch/recent");
  const latest = dispatch?.data.at(-1);
  if (!dispatch || !latest) {
    throw new Error("The live dispatch is unavailable");
  }
  const [time, ...values] = latest;
  const prices = dispatch.pricing.at(-1)!.slice(1) as (number | null)[];

  const units = getAllUnits().filter(
    (unit) => isInService(unit, now) && matchesUnitFilter(unit, args),
  );
  const capacity = sumByGroup(
    units.map((unit) => [unit, unit.capacity]),
    groupBy,
  );
  const out = sumByGroup(
    getActiveOutages(outages ?? {}, now).filter(([unit]) => matchesUnitFilter(unit, args)),
    groupBy,
  );

  const generation = groupNodes("generation", groupBy, args, dispatch.series, values);
  // groups that aren't generating at all (e.g. Huntly's Rankine units) are listed too
  for (const group of capacity.keys()) {
    generation.values.set(group, generation.values.get(group) ?? 0);
  }
  const { columns, rows, total } = toTable(
    [{ label: time, values: generation.values }],
    args.top ?? DEFAULT_TOP,
    1,
  );
  const groups = columns.slice(1).filter((column) => column !== "total");
  // the groups summed into Other, if there are more than top
  const otherSum = (sums: Map<string, number>) =>
    [...sums]
      .filter(([group]) => !groups.includes(group))
      .reduce((sum, [, value]) => sum + value, 0);
  const valueFor = (sums: Map<string, number>, group: string) =>
    group.startsWith("Other (") ? otherSum(sums) : sums.get(group);

  const demand = (demandGroupBy: string) =>
    groupNodes("demand", demandGroupBy, {}, dispatch.series, values).values;

  const gxpPrices = dispatch.series
    .map((node, index) => ({ node, price: prices[index] }))
    .filter(({ node, price }) => !isUnitNode(node) && price !== null) as {
    node: string;
    price: number;
  }[];
  const hvdc = dispatch.hvdc.data.at(-1);
  const priceAt = (request: string) =>
    prices[dispatch.series.indexOf(resolvePriceNode(request, dispatch.series) ?? "")] ?? null;

  return {
    asOf: time,
    generation: {
      unit: "MW",
      groupBy,
      columns: ["group", "MW", "share_%", "capacity_in_service_MW", "out_for_outages_MW"],
      rows: groups.map((group, index) => [
        group,
        rows[0][index + 1],
        total === 0 ? 0 : round((Number(rows[0][index + 1]) / total) * 100, 1),
        round(valueFor(capacity, group) ?? 0, 1),
        round(valueFor(out, group) ?? 0, 1),
      ]),
      totalMW: total,
      ...(args.fuel?.length
        ? {}
        : {
            renewableSharePercent: total === 0 ? 0 : round((generation.renewable / total) * 100, 1),
          }),
    },
    demandMW: Object.fromEntries(
      [...demand("island")]
        .map(([island, mw]) => [island, round(mw, 1)])
        .concat([["total", round(demand("total").get("Total") ?? 0, 1)]]),
    ),
    hvdc: hvdc && {
      at: hvdc[0],
      northMW: hvdc[1],
      southMW: hvdc[2] === null ? null : Math.abs(Number(hvdc[2])),
      northLimitMW: hvdc[3] ?? null,
      southLimitMW: hvdc[4] === null || hvdc[4] === undefined ? null : Math.abs(Number(hvdc[4])),
    },
    prices: {
      unit: "$/MWh",
      OTA2201: priceAt("OTA2201"),
      BEN2201: priceAt("BEN2201"),
      lowest: describePrice(
        gxpPrices.reduce((min, price) => (price.price < min.price ? price : min), gxpPrices[0]),
      ),
      highest: describePrice(
        gxpPrices.reduce((max, price) => (price.price > max.price ? price : max), gxpPrices[0]),
      ),
    },
    notes: [
      "Generation is the grid's dispatched units, without rooftop solar. Demand is what's taken from the grid, at grid exit points " +
        "and by dispatchable loads and batteries charging.",
      "Capacity in service is the units commissioned and not retired, whether or not they're available. Outages are planned and " +
        "unplanned generation outages from Transpower's POCP, which can overlap (e.g. a station and one of its units).",
      "The HVDC's flows are each half hour's average, published about half an hour after it ends.",
    ],
  };
}

export function isInService(unit: UnitInfo, at: Date): boolean {
  return (
    !unit.charging &&
    !unit.combines &&
    unit.commissioned !== undefined &&
    Date.parse(unit.commissioned) <= at.getTime() &&
    (unit.decommissioned === undefined || Date.parse(unit.decommissioned) > at.getTime())
  );
}

// each outage going on at a time, with the unit it's for and the MW it takes out
export function getActiveOutages(outages: Outages, at: Date): [UnitInfo, number][] {
  return Object.entries(outages).flatMap(([node, unitOutages]) =>
    unitOutages
      .filter(
        (outage) =>
          Date.parse(outage.timeStart) <= at.getTime() && Date.parse(outage.timeEnd) > at.getTime(),
      )
      .map((outage) => [getUnit(node), outage.mwattLost] as [UnitInfo, number]),
  );
}

function sumByGroup(values: [UnitInfo, number][], groupBy: GenerationGroup): Map<string, number> {
  const sums = new Map<string, number>();
  for (const [unit, value] of values) {
    const group = generationGroupOf(unit, groupBy);
    sums.set(group, (sums.get(group) ?? 0) + value);
  }
  return sums;
}

function describePrice(price: { node: string; price: number } | undefined) {
  return (
    price && { node: price.node, substation: getGxp(price.node).substation, price: price.price }
  );
}

// in the same format as the dispatch's timestamps, e.g. 2026-10-14T22:00:00
export function toNzTime(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(date)
    .replace(" ", "T");
}
