import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { DispatchAggregate } from "../models/dispatchAggregate";

const aggregate = (...froms: string[]): DispatchAggregate => ({
  data: froms.map(from => ({
    from,
    to: from,
    nodes: {
      "ATI2201 ATI0": { g: 1200, l: 0 },
      "HLY2201 HLY1": { g: 2400, l: 0.5 },
      "HLY2201 HLY5": { g: 9000, l: 0 },
    },
  })),
});

async function storeAggregate(key: string, value: DispatchAggregate) {
  await env.dispatch.put(key, JSON.stringify(value));
}

async function getJson(path: string) {
  const { response } = await requestWorker(path);
  return { response, json: await response.json() as any };
}

describe("aggregates api", () => {
  it("returns the latest aggregated date", async () => {
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-12");

    const { json } = await getJson("/v1/dispatch/aggregates");

    expect(json).toEqual({ latestDate: "2026-10-12" });
  });

  it("returns a month's daily totals as net MWh for each node", async () => {
    await storeAggregate("aggregate-daily-2026-10", aggregate("2026-10-01", "2026-10-02"));

    const { response, json } = await getJson("/v1/dispatch/aggregates/2026/10");

    expect(response.status).toBe(200);
    expect(json).toEqual({
      series: ["ATI2201 ATI0", "HLY2201 HLY1", "HLY2201 HLY5"],
      data: [
        ["2026-10-01", 1200, 2399.5, 9000],
        ["2026-10-02", 1200, 2399.5, 9000],
      ],
    });
  });

  it("accepts single digit months", async () => {
    await storeAggregate("aggregate-daily-2026-01", aggregate("2026-01-01"));

    const { response } = await getJson("/v1/dispatch/aggregates/2026/1");

    expect(response.status).toBe(200);
  });

  it("rejects invalid months", async () => {
    const { response, json } = await getJson("/v1/dispatch/aggregates/2026/13");

    expect(response.status).toBe(400);
    expect(json).toEqual({ message: "Invalid month, expected 1-12" });
  });

  it.each([
    ["weekly", "/v1/dispatch/aggregates/2026/weekly", "aggregate-weekly-2026"],
    ["monthly", "/v1/dispatch/aggregates/2026/monthly", "aggregate-monthly-2026"],
    ["annual", "/v1/dispatch/aggregates/annual", "aggregate-annual"],
  ])("returns the %s totals", async (_, path, key) => {
    await storeAggregate(key, aggregate("2026-01-01"));

    const { json } = await getJson(path);

    expect(json.data).toEqual([["2026-01-01", 1200, 2399.5, 9000]]);
  });

  it("filters to nodes starting with any of the given prefixes", async () => {
    await storeAggregate("aggregate-daily-2026-10", aggregate("2026-10-01"));

    const { json } = await getJson("/v1/dispatch/aggregates/2026/10?nodes=HLY2201 HLY1, ATI2201");

    expect(json).toEqual({
      series: ["ATI2201 ATI0", "HLY2201 HLY1"],
      data: [["2026-10-01", 1200, 2399.5]],
    });
  });

  it("returns 404 for periods with no data", async () => {
    const { response, json } = await getJson("/v1/dispatch/aggregates/2019/10");

    expect(response.status).toBe(404);
    expect(json).toEqual({ message: "No data for this period" });
  });

  describe("caching", () => {
    async function getCacheControl(path: string, key: string, latestDate?: string) {
      await storeAggregate(key, aggregate("2026-01-01"));
      if (latestDate) {
        await env.dispatch_kv.put("latestAggregatedDispatchDate", latestDate);
      }
      const { response } = await requestWorker(path);
      return response.headers.get("Cache-Control");
    }

    it("caches complete periods for a day", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/9", "aggregate-daily-2026-09", "2026-10-01")).toBe("max-age=86400");
      expect(await getCacheControl("/v1/dispatch/aggregates/2025/monthly", "aggregate-monthly-2025", "2026-01-01")).toBe("max-age=86400");
    });

    it("caches periods that are still receiving data for an hour", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-12")).toBe("max-age=3600");
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-31")).toBe("max-age=3600");
    });

    it("treats weeks as incomplete until the last week of the year could have ended", async () => {
      // the last ISO week of 2025 runs until Sunday 4 January 2026
      expect(await getCacheControl("/v1/dispatch/aggregates/2025/weekly", "aggregate-weekly-2025", "2026-01-03")).toBe("max-age=3600");
      expect(await getCacheControl("/v1/dispatch/aggregates/2025/weekly", "aggregate-weekly-2025", "2026-01-04")).toBe("max-age=86400");
    });

    it("caches annual totals for an hour, as the current year is always included", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/annual", "aggregate-annual", "2030-01-01")).toBe("max-age=3600");
    });

    it("caches for an hour before anything has been aggregated", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/9", "aggregate-daily-2026-09")).toBe("max-age=3600");
    });
  });
});
