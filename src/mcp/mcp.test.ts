import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { outage } from "../testing/fixtures";
import { DispatchAggregate } from "../models/dispatchAggregate";
import { ApiClient } from "./api";
import { getEnergy } from "./tools/energy";
import { getPrices } from "./tools/prices";
import { getDayProfile } from "./tools/dayProfile";
import { getCurrentState } from "./tools/live";
import { getOutages } from "./tools/outages";
import { getOffers } from "./tools/offers";
import { getGeneratingCapacity, searchGenerators } from "./tools/generators";

// the tools request the worker's own routes, as they do in production
const api = new ApiClient(async path => (await requestWorker(path)).response);

const aggregate = (...days: [string, DispatchAggregate["data"][number]["nodes"]][]): DispatchAggregate => ({
  data: days.map(([from, nodes]) => ({ from, to: from, nodes })),
});

// Ātiamuri and Benmore are hydro, Huntly 5 gas, HLY91 is Huntly's battery charging and OTA0221 a grid exit point
const DAY_NODES = {
  "ATI2201 ATI0": { g: 1200, l: 0 },
  "BEN2202 BEN0": { g: 3000, l: 0 },
  "HLY2201 HLY5": { g: 9000, l: 0 },
  "HLY2201 HLY91": { g: 0, l: 50 },
  "OTA0221": { g: 0, l: 8000 },
};

const record = (p: string, g: number, l: number, c: number) => ({ p, g: `${g}`, l: `${l}`, c: `${c}` });

// a few of a day's 5-minute intervals, as EMI's daily dispatch files have them. Ōtāhuhu's only node is OTA0221 and
// Benmore's its unit's, as the files leave out nodes with no generation or load
const DISPATCH_DAY = {
  "2026-10-12T00:00:00": [record("ATI2201 ATI0", 60, 0, 100), record("HLY2201 HLY5", 300, 0, 100), record("OTA0221", 0, 500, 100), record("BEN2202 BEN0", 200, 0, 40)],
  "2026-10-12T00:05:00": [record("ATI2201 ATI0", 80, 0, 140), record("HLY2201 HLY5", 300, 0, 140), record("OTA0221", 0, 500, 140), record("BEN2202 BEN0", 200, 0, 20)],
  "2026-10-12T00:30:00": [record("ATI2201 ATI0", 70, 0, 300), record("OTA0221", 0, 400, 300), record("BEN2202 BEN0", 100, 0, 30)],
};

async function store(bucket: R2Bucket, key: string, value: unknown) {
  await bucket.put(key, JSON.stringify(value));
}

beforeEach(() => {
  // 22:01 on 14 October 2026 in NZ
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T09:01:00Z"));
});

describe("get_energy", () => {
  beforeEach(async () => {
    await store(env.dispatch, "aggregate-daily-2026-10", aggregate(["2026-10-01", DAY_NODES], ["2026-10-02", DAY_NODES]));
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-01");
  });

  it("groups generation by fuel in GWh, with the renewable share and the periods still receiving data", async () => {
    const result = await getEnergy(api, { resolution: "daily", from: "2026-10-01", to: "2026-10-02" });

    expect(result).toMatchObject({
      metric: "generation",
      unit: "GWh",
      groupBy: "fuel",
      columns: ["period", "Gas", "Hydro", "total", "renewable_share_%"],
      rows: [
        ["2026-10-01", 9, 4.2, 13.2, 31.8],
        ["2026-10-02", 9, 4.2, 13.2, 31.8],
      ],
      totals: { Gas: { value: 18, share: 68.2 }, Hydro: { value: 8.4, share: 31.8 } },
      total: 26.4,
      renewableSharePercent: 31.8,
      latestCompleteDate: "2026-10-01",
      incompletePeriods: ["2026-10-02"],
    });
  });

  it("counts load at grid exit points and units (e.g. a battery charging) as demand", async () => {
    const result = await getEnergy(api, { metric: "demand", resolution: "daily", from: "2026-10-01", to: "2026-10-01" });

    expect(result).toMatchObject({ groupBy: "island", columns: ["period", "North"], rows: [["2026-10-01", 8.05]] });
  });

  it("filters generation and sums the groups after top into Other", async () => {
    const southern = await getEnergy(api, { resolution: "daily", from: "2026-10-01", to: "2026-10-01", group_by: "station", island: "South" });
    const top = await getEnergy(api, { resolution: "daily", from: "2026-10-01", to: "2026-10-01", group_by: "unit", top: 1 });

    expect(southern).toMatchObject({ columns: ["period", "Benmore", "renewable_share_%"], rows: [["2026-10-01", 3, 100]] });
    expect(top).toMatchObject({
      columns: ["period", "Huntly Unit 5 (HLY2201 HLY5)", "Other (2 more)", "total", "renewable_share_%"],
      rows: [["2026-10-01", 9, 4.2, 13.2, 31.8]],
    });
  });

  it("reads each year's file for months that span years", async () => {
    await store(env.dispatch, "aggregate-monthly-2025", aggregate(["2025-11-01", DAY_NODES], ["2025-12-01", DAY_NODES]));
    await store(env.dispatch, "aggregate-monthly-2026", aggregate(["2026-01-01", DAY_NODES]));

    const result = await getEnergy(api, { resolution: "monthly", from: "2025-12", to: "2026-01", group_by: "total" });

    expect(result).toMatchObject({ columns: ["period", "Total", "renewable_share_%"], rows: [["2025-12", 13.2, 31.8], ["2026-01", 13.2, 31.8]] });
  });

  it("has no demand before the dispatch data began", async () => {
    await store(env.dispatch, "aggregate-annual", aggregate(["2019-01-01", { "ATI2201 ATI0": { g: 1200, l: 0 } }], ["2021-01-01", DAY_NODES]));

    const result = await getEnergy(api, { metric: "demand", resolution: "annual", from: "2019", to: "2021" });

    expect(result).toMatchObject({ rows: [["2019", null], ["2021", 8.05]] });
  });

  it("flags HVDC periods after EMI's latest metered month as incomplete", async () => {
    const hvdc = { northFlow: { g: 500000, l: 0 }, southFlow: { g: 1000, l: 0 } };
    await store(env.dispatch, "aggregate-monthly-2026", aggregate(["2026-08-01", DAY_NODES], ["2026-09-01", DAY_NODES]));
    await store(env.dispatch, "aggregate-hvdc-monthly-2026", aggregate(["2026-08-01", hvdc], ["2026-09-01", hvdc]));
    await env.dispatch_kv.put("latestMeteredHvdcDate", "2026-08-31");

    const result = await getEnergy(api, { metric: "hvdc", from: "2026-08", to: "2026-09" });

    expect(result).toMatchObject({
      columns: ["period", "north", "south", "total"],
      rows: [["2026-08", 500, 1, 501], ["2026-09", 500, 1, 501]],
      latestCompleteDate: "2026-08-31",
      incompletePeriods: ["2026-09"],
    });
  });

  it("rejects arguments that don't make sense", async () => {
    await expect(getEnergy(api, { from: "2026-10", to: "2026-09" })).rejects.toThrow("from (2026-10-01) is after to (2026-09-30)");
    await expect(getEnergy(api, { from: "2026-13" })).rejects.toThrow('Invalid date "2026-13"');
    await expect(getEnergy(api, { metric: "demand", fuel: ["Hydro"] })).rejects.toThrow("Demand can only be filtered by island");
    await expect(getEnergy(api, { group_by: "substation" })).rejects.toThrow("group_by for generation must be one of");
  });
});

describe("get_prices", () => {
  beforeEach(async () => {
    await store(env.dispatch, "dispatch-20261012", DISPATCH_DAY);
  });

  it("returns a day's prices by half hour at the reference nodes, from the nearest nodes the day has", async () => {
    const result = await getPrices(api, { from: "2026-10-12" });

    expect(result).toMatchObject({
      resolution: "30min",
      nodes: [
        { requested: "OTA2201", nodesUsed: ["OTA0221"], substation: "Ōtāhuhu", island: "North" },
        { requested: "BEN2201", nodesUsed: ["BEN2202 BEN0"], substation: "Benmore AC", island: "South" },
      ],
      columns: ["period", "OTA2201", "BEN2201"],
      rows: [["2026-10-12T00:00", 120, 30], ["2026-10-12T00:30", 300, 30]],
      summary: {
        OTA2201: {
          intervals: 3, mean: 180, median: 140, p10: 100, p90: 300,
          min: { price: 100, at: "2026-10-12T00:00:00" },
          max: { price: 300, at: "2026-10-12T00:30:00" },
        },
      },
    });
  });

  it("takes the days EMI hasn't published from the live dispatch", async () => {
    await store(env.dispatch, "timeseries", {
      series: ["OTA2201", "BEN2201"],
      data: [["2026-10-14T00:00:00", -500, 0], ["2026-10-14T00:05:00", -500, 0]],
      pricing: [["2026-10-14T00:00:00", 200, 50], ["2026-10-14T00:05:00", 100, 50]],
    });

    const result = await getPrices(api, { from: "2026-10-12", to: "2026-10-14", nodes: ["Otahuhu"] });

    expect(result).toMatchObject({
      resolution: "daily",
      nodes: [{ requested: "Otahuhu", nodesUsed: ["OTA0221", "OTA2201"] }],
      columns: ["period", "Otahuhu mean", "Otahuhu min", "Otahuhu max"],
      rows: [["2026-10-12", 180, 100, 300], ["2026-10-14", 150, 100, 200]],
      missingDates: ["2026-10-13"],
      liveDates: ["2026-10-14"],
    });
  });

  it("rejects more than a month, or nodes with no prices", async () => {
    await expect(getPrices(api, { from: "2026-08-01", to: "2026-09-30" })).rejects.toThrow("That's 61 days");
    await expect(getPrices(api, { from: "2026-10-12", nodes: ["Nowhere"] })).rejects.toThrow("No prices for Nowhere");
  });
});

describe("get_day_profile", () => {
  beforeEach(async () => {
    await store(env.dispatch, "dispatch-20261012", DISPATCH_DAY);
    await store(env.dispatch, "hvdc-metered-20261012", {
      series: ["northFlow", "southFlow"],
      data: [["2026-10-12T00:00:00", 600, 0], ["2026-10-12T00:30:00", 500, 10]],
    });
  });

  it("averages the intervals in each half hour, with each group's peak and energy", async () => {
    const result = await getDayProfile(api, { date: "2026-10-12", include_hvdc: true, include_prices: true });

    expect(result).toMatchObject({
      resolution: "30min",
      live: false,
      columns: ["period", "Hydro", "Gas", "total", "hvdc_north_MW", "hvdc_south_MW", "OTA2201_$/MWh (from OTA0221)", "BEN2201_$/MWh (from BEN2202 BEN0)"],
      rows: [
        ["2026-10-12T00:00", 270, 300, 570, 600, 0, 120, 30],
        ["2026-10-12T00:30", 170, 0, 170, 500, 10, 300, 30],
      ],
      summary: {
        Hydro: { meanMW: 220, peakMW: 270, peakAt: "2026-10-12T00:00", lowestMW: 170, lowestAt: "2026-10-12T00:30", energyGWh: 5.28 },
        total: { meanMW: 370, peakMW: 570, energyGWh: 8.88 },
      },
    });
    expect(result.notes).toContain("285 of the day's 288 intervals are missing from EMI's data, so rows without any are left out and the energy averages the rest.");
  });

  it("says when there's no data for the day", async () => {
    await expect(getDayProfile(api, { date: "2026-10-01" })).rejects.toThrow("There's no dispatch for 2026-10-01");
  });
});

describe("get_current_state", () => {
  beforeEach(async () => {
    const row = (time: string, ...values: number[]) => [time, ...values];
    await store(env.dispatch, "timeseries", {
      series: ["ATI2201 ATI0", "HLY2201 HLY5", "HLY2201 HLY91", "OTA2201", "BEN2201", "MAN2201"],
      data: [row("2026-10-14T21:55:00", 60, 0, -40, -500, 0, 0), row("2026-10-14T22:00:00", 80, 300, -50, -450, 0, 0)],
      pricing: [row("2026-10-14T21:55:00", 140, 140, 140, 140, 30, 10), row("2026-10-14T22:00:00", 150, 150, 150, 150, 30, 10)],
    });
    await store(env.dispatch, "hvdc", { series: ["northFlow", "southFlow", "northLimit", "southLimit"], data: [["2026-10-14T21:00:00", 700, 0, 1200, -600]] });
    await env.dispatch_kv.put("latestOutages", JSON.stringify({ "HLY2201 HLY5": [outage("HLY_5", { mwattLost: 385 })] }));
  });

  it("returns the latest interval's generation against the capacity in service and out for outages", async () => {
    const result = await getCurrentState(api, { station: ["Huntly"] });

    expect(result).toMatchObject({
      asOf: "2026-10-14T22:00:00",
      generation: {
        columns: ["group", "MW", "share_%", "capacity_in_service_MW", "out_for_outages_MW"],
        rows: [["Gas", 300, 100, 449, 385], ["Coal/Gas", 0, 0, 720, 0], ["Battery", 0, 0, 100, 0]],
        totalMW: 300,
        renewableSharePercent: 0,
      },
      demandMW: { North: 500, total: 500 },
      hvdc: { at: "2026-10-14T21:00:00", northMW: 700, southMW: 0, northLimitMW: 1200, southLimitMW: 600 },
      prices: { OTA2201: 150, BEN2201: 30, lowest: { node: "MAN2201", price: 10 }, highest: { node: "OTA2201", price: 150 } },
    });
  });
});

describe("get_outages", () => {
  beforeEach(async () => {
    await env.dispatch_kv.put("latestOutages", JSON.stringify({
      "HLY2201 HLY5": [outage("HLY_5", { mwattLost: 385 })],
      "ATI2201 ATI0": [outage("ATI_0", { timeStart: "2026-10-15T08:00:00Z", timeEnd: "2026-10-15T10:00:00Z", mwattLost: 84 })],
      "BEN2202 BEN0": [outage("BEN_1", { timeStart: "2026-10-10T08:00:00Z", timeEnd: "2026-10-11T08:00:00Z", mwattLost: 95 })],
    }));
  });

  it("sums the MW out now, and lists the outages going on or coming up", async () => {
    const result = await getOutages(api, {});

    expect(result).toMatchObject({
      at: "2026-10-14T22:01:00",
      outAt: [{ group: "Gas", mwOut: 385, outages: 1 }],
      totalMWOut: 385,
      matchingOutages: 2,
    });
    expect(result.outages.map(outage => [outage.node, outage.status])).toEqual([["HLY2201 HLY5", "active"], ["ATI2201 ATI0", "upcoming"]]);
  });

  it("sums the outages at another time, and can list the ended ones", async () => {
    const result = await getOutages(api, { at: "2026-10-15T08:30:00Z", group_by: "station", include_ended: true });

    expect(result).toMatchObject({
      outAt: [{ group: "Huntly", mwOut: 385 }, { group: "Ātiamuri", mwOut: 84 }],
      totalMWOut: 469,
      matchingOutages: 3,
    });
  });
});

describe("get_offers", () => {
  beforeEach(async () => {
    await store(env.offers, "offers-20261012", {
      "1": { "ATI2201 ATI0": [{ tranche: 1, megawatts: 10, price: 0 }] },
      "37": {
        "ATI2201 ATI0": [{ tranche: 1, megawatts: 40, price: 0.01 }, { tranche: 2, megawatts: 20, price: 150 }],
        "HLY2201 HLY5": [{ tranche: 1, megawatts: 200, price: 90 }, { tranche: 2, megawatts: 200, price: 400 }],
      },
      "38": {
        "ATI2201 ATI0": [{ tranche: 1, megawatts: 60, price: 0.01 }],
        "HLY2201 HLY5": [{ tranche: 1, megawatts: 400, price: 90 }],
      },
    });
    await store(env.offers, "fogp-20261012", { "37": { "TWH0331 TUK0": 50 }, "38": { "TWH0331 TUK0": 30 } });
  });

  it("averages the trading periods' offers into a supply curve and by group", async () => {
    const result = await getOffers(api, { date: "2026-10-12", trading_periods: "37-38", price_bands: [500, 0.01, 100] });

    expect(result).toMatchObject({
      date: "2026-10-12",
      tradingPeriods: { first: 37, last: 38, count: 2 },
      offeredMW: 460,
      supplyCurve: [{ atOrBelowPrice: 0.01, mw: 50 }, { atOrBelowPrice: 100, mw: 350 }, { atOrBelowPrice: 500, mw: 460 }],
      groups: {
        columns: ["group", "offered_MW", "mw_weighted_mean_price", "highest_price", "at_or_below_$0.01", "at_or_below_$100", "at_or_below_$500"],
        rows: [["Gas", 400, 167.5, 400, 0, 300, 400], ["Hydro", 60, 25.01, 150, 50, 50, 60]],
      },
      generationPotentialForecastMW: { Wind: 40 },
    });
  });

  it("reads the latest day's offers by default", async () => {
    await env.dispatch_kv.put("latestSyncedOffers", "20261012");

    const result = await getOffers(api, {});

    expect(result).toMatchObject({ date: "2026-10-12", tradingPeriods: { first: 1, last: 38, count: 3 } });
  });

  it("rejects trading periods that don't exist", async () => {
    await expect(getOffers(api, { date: "2026-10-12", trading_periods: "40-60" })).rejects.toThrow('Invalid trading_periods "40-60"');
  });
});

describe("search_generators", () => {
  it("finds stations without their macrons, leaving out retired units unless asked", () => {
    const manapouri = searchGenerators({ query: "manapouri" });
    const huntly = searchGenerators({ query: "Huntly" });
    const huntlyWithRetired = searchGenerators({ query: "Huntly", include_retired: true });

    expect(manapouri.stations[0]).toMatchObject({
      station: "Manapōuri",
      operator: "Meridian Energy",
      island: "South",
      units: [{ node: "MAN2201 MAN0", fuel: "Hydro", capacityMW: 800, commissioned: "1969-09-14" }],
    });
    const nodes = (result: ReturnType<typeof searchGenerators>) => result.stations[0].units.map(unit => unit.node);
    expect(nodes(huntly)).not.toContain("HLY2201 HLY3");
    expect(nodes(huntlyWithRetired)).toEqual(expect.arrayContaining(["HLY2201 HLY3", "HLY2201 huntly_1_4"]));
  });

  it("says when nothing matches", () => {
    expect(() => searchGenerators({ query: "nowhere" })).toThrow("Nothing matched");
  });
});

describe("get_generating_capacity", () => {
  it("sums the capacity in service on a date, and what's been commissioned since another", () => {
    const now = getGeneratingCapacity({ station: ["HLY"], as_of: "2026-10-14", changes_since: "2026" });
    const then = getGeneratingCapacity({ station: ["HLY"], as_of: "2010" });

    expect(now).toMatchObject({
      groups: [
        { group: "Coal/Gas", capacityMW: 720, units: 3, stations: 1 },
        { group: "Gas", capacityMW: 449, units: 2, stations: 1 },
        { group: "Battery", capacityMW: 100, units: 1, stations: 1 },
      ],
      totalMW: 1269,
      changes: { since: "2026-01-01", commissioned: [{ unit: "Huntly Battery", date: "2026-07-02", capacityMW: 100 }], retired: [] },
    });
    expect(then).toMatchObject({ asOf: "2010-12-31", totalMW: 1409 });
  });
});

describe("/mcp", () => {
  const rpc = async (method: string, params: unknown = {}) => {
    const { response } = await requestWorker("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { response, json: await response.json() as any };
  };

  it("initializes with instructions for the agent", async () => {
    const { response, json } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });

    expect(response.status).toBe(200);
    expect(json.result.serverInfo).toMatchObject({ name: "nz-electricity-stats" });
    expect(json.result.instructions).toContain("New Zealand's wholesale electricity market");
  });

  it("lists the tools", async () => {
    const { json } = await rpc("tools/list");

    expect(json.result.tools.map((tool: any) => tool.name)).toEqual([
      "get_energy", "get_day_profile", "get_prices", "get_current_state", "search_generators", "get_generating_capacity", "get_outages", "get_offers",
    ]);
  });

  it("calls a tool, returning its result as JSON", async () => {
    const { json } = await rpc("tools/call", { name: "search_generators", arguments: { query: "Manapouri" } });

    expect(json.result.isError).toBeUndefined();
    expect(JSON.parse(json.result.content[0].text).stations[0].station).toBe("Manapōuri");
  });

  it("returns a tool's errors for the agent to read", async () => {
    const { json } = await rpc("tools/call", { name: "get_energy", arguments: { from: "last year" } });

    expect(json.result).toEqual({
      isError: true,
      content: [{ type: "text", text: 'Invalid date "last year", expected YYYY, YYYY-MM or YYYY-MM-DD' }],
    });
  });

  it("has no stream to open, as it's stateless", async () => {
    const { response } = await requestWorker("/mcp");

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});
