import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  describe("days that haven't been aggregated yet", () => {
    // the live dispatch's net MW for each node at each interval
    async function storeLiveDispatch(data: (string | number)[][]) {
      await env.dispatch.put("timeseries", JSON.stringify({ series: ["ATI2201 ATI0", "HLY2201 HLY1"], data, pricing: [] }));
    }

    beforeEach(async () => {
      await storeLiveDispatch([
        ["2026-10-23T00:00:00", 50, -1],
        ["2026-10-23T12:00:00", 50, -1],
        // today, up to midday
        ["2026-10-24T00:00:00", 100, 0],
        ["2026-10-24T11:55:00", 100, 0],
      ]);
    });

    it("come from the live dispatch, and are cached for 5 minutes", async () => {
      await storeAggregate("aggregate-daily-2026-10", aggregate("2026-10-21", "2026-10-22"));
      await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-22", { metadata: { updatedAt: Date.now() } });

      const { response, json } = await getJson("/v1/dispatch/aggregates/2026/10");

      expect(json).toEqual({
        series: ["ATI2201 ATI0", "HLY2201 HLY1", "HLY2201 HLY5"],
        data: [
          ["2026-10-21", 1200, 2399.5, 9000],
          ["2026-10-22", 1200, 2399.5, 9000],
          ["2026-10-23", 1200, -24, 0],
          ["2026-10-24", 1200, 0, 0],
        ],
      });
      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });

    // the aggregate file can have the day before latestAggregatedDispatchDate does, as KV takes a while to update
    it.each(["2026-10-23", "2026-10-22"])("are replaced by the aggregated day once it's available (latest date %s)", async (latestDate) => {
      await storeAggregate("aggregate-daily-2026-10", aggregate("2026-10-22", "2026-10-23"));
      await env.dispatch_kv.put("latestAggregatedDispatchDate", latestDate);

      const { json } = await getJson("/v1/dispatch/aggregates/2026/10");

      expect(json.data).toEqual([
        ["2026-10-22", 1200, 2399.5, 9000],
        ["2026-10-23", 1200, 2399.5, 9000],
        ["2026-10-24", 1200, 0, 0],
      ]);
    });

    it("aren't added for days the daily sync has passed without a file", async () => {
      await storeAggregate("aggregate-daily-2026-10", aggregate("2026-10-22"));
      await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-23");

      const { json } = await getJson("/v1/dispatch/aggregates/2026/10");

      expect(json.data.map((row: any[]) => row[0])).toEqual(["2026-10-22", "2026-10-24"]);
    });

    it("are returned for a month that doesn't have any aggregated days yet", async () => {
      await storeLiveDispatch([
        ["2026-10-31T00:00:00", 50, 0],
        ["2026-11-01T00:00:00", 100, 0],
      ]);
      await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-30");

      const { response, json } = await getJson("/v1/dispatch/aggregates/2026/11");

      expect(response.status).toBe(200);
      expect(json).toEqual({
        series: ["ATI2201 ATI0"],
        data: [["2026-11-01", 8.333]],
      });
      expect((await getJson("/v1/dispatch/aggregates/2026/10")).json.data).toEqual([["2026-10-31", 1200]]);
    });

    it("are filtered by node", async () => {
      await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-22");

      const { json } = await getJson("/v1/dispatch/aggregates/2026/10?nodes=HLY2201");

      expect(json).toEqual({
        series: ["HLY2201 HLY1"],
        data: [["2026-10-23", -24], ["2026-10-24", 0]],
      });
    });

    // the live dispatch is a few MB, so it's only read when it could have days for the period
    it("aren't read for months that have ended, or for the weekly, monthly and annual totals", async () => {
      await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-22");
      const get = vi.spyOn(env.dispatch, "get");

      for (const [path, key] of [
        ["/v1/dispatch/aggregates/2026/9", "aggregate-daily-2026-09"],
        ["/v1/dispatch/aggregates/2026/weekly", "aggregate-weekly-2026"],
        ["/v1/dispatch/aggregates/2026/monthly", "aggregate-monthly-2026"],
        ["/v1/dispatch/aggregates/annual", "aggregate-annual"],
      ]) {
        await storeAggregate(key, aggregate("2026-01-01"));
        expect((await getJson(path)).json.data).toEqual([["2026-01-01", 1200, 2399.5, 9000]]);
      }
      expect(get).not.toHaveBeenCalledWith("timeseries");
    });
  });

  describe("caching", () => {
    const NOW = new Date("2026-10-15T09:00:00Z").getTime();
    const HOUR_MS = 60 * 60 * 1000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    // updatedAt is when new days were last aggregated, as stored by syncDispatchAggregates
    async function getCacheControl(path: string, key: string, latestDate?: string, updatedAt = NOW - 6 * HOUR_MS) {
      await storeAggregate(key, aggregate("2026-01-01"));
      if (latestDate) {
        await env.dispatch_kv.put("latestAggregatedDispatchDate", latestDate, { metadata: { updatedAt } });
      }
      const { response } = await requestWorker(path);
      return response.headers.get("Cache-Control");
    }

    it("caches complete periods for 30 days", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/9", "aggregate-daily-2026-09", "2026-10-01")).toBe("max-age=2592000");
      expect(await getCacheControl("/v1/dispatch/aggregates/2025/monthly", "aggregate-monthly-2025", "2026-01-01")).toBe("max-age=2592000");
    });

    it("caches periods that are still receiving data until a day after the last update", async () => {
      // updated 6 hours ago, so the next day is due in 18 hours
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-12")).toBe("max-age=64800");
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-31")).toBe("max-age=64800");
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-14", NOW - 1000)).toBe("max-age=86399");
    });

    it("caches periods that are still receiving data briefly once the next day is overdue", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-13", NOW - 24 * HOUR_MS)).toBe("max-age=300");
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/10", "aggregate-daily-2026-10", "2026-10-12", NOW - 30 * HOUR_MS)).toBe("max-age=300");
    });

    it("caches periods that are still receiving data briefly if the last update time isn't known", async () => {
      // e.g. aggregated before the update time was recorded
      await storeAggregate("aggregate-daily-2026-10", aggregate("2026-10-01"));
      await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-14");

      const { response } = await requestWorker("/v1/dispatch/aggregates/2026/10");

      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });

    it("treats weeks as incomplete until the last week of the year could have ended", async () => {
      // the last ISO week of 2025 runs until Sunday 4 January 2026
      expect(await getCacheControl("/v1/dispatch/aggregates/2025/weekly", "aggregate-weekly-2025", "2026-01-03")).toBe("max-age=64800");
      expect(await getCacheControl("/v1/dispatch/aggregates/2025/weekly", "aggregate-weekly-2025", "2026-01-04")).toBe("max-age=2592000");
    });

    it("treats annual totals as incomplete, as the current year is always included", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/annual", "aggregate-annual", "2030-01-01")).toBe("max-age=64800");
    });

    it("caches briefly before anything has been aggregated", async () => {
      expect(await getCacheControl("/v1/dispatch/aggregates/2026/9", "aggregate-daily-2026-09")).toBe("max-age=300");
    });
  });
});
