import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { queueForReaggregation, syncDispatchAggregates } from "./syncDispatchAggregates";

const NODE = "ATI2201 ATI0";

// stores a daily dispatch file with the node at a constant output, so it generates mw x 24 MWh that day
async function storeDailyFile(date: string, mw: number) {
  await env.dispatch.put("dispatch-" + date.replace(/-/g, ""), JSON.stringify({
    [`${date}T00:00:00`]: [{ p: NODE, g: `${mw}`, l: "0", c: "100" }],
  }));
}

const dataPoint = (from: string, to: string, mwh: number) => ({ from, to, nodes: { [NODE]: { g: mwh, l: 0 } } });
const day = (date: string, mwh: number) => dataPoint(date, date, mwh);

async function getAggregate(key: string) {
  return await (await env.dispatch.get(key))?.json();
}

describe("syncDispatchAggregates", () => {
  it("waits until the daily dispatch has been synced", async () => {
    await storeDailyFile("2026-10-05", 10);

    await syncDispatchAggregates();

    expect(await env.dispatch.get("aggregate-daily-2026-10")).toBeNull();
    expect(await env.dispatch_kv.get("latestAggregatedDispatchDate")).toBeNull();
  });

  it("totals each day's energy by day, week, month and year", async () => {
    await storeDailyFile("2026-10-05", 10);
    await storeDailyFile("2026-10-06", 20);
    await storeDailyFile("2026-10-12", 5);
    await env.dispatch_kv.put("latestDailySyncDate", "20261012");

    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2026-10")).toEqual({
      data: [day("2026-10-05", 240), day("2026-10-06", 480), day("2026-10-12", 120)],
    });
    expect(await getAggregate("aggregate-weekly-2026")).toEqual({
      data: [dataPoint("2026-10-05", "2026-10-11", 720), dataPoint("2026-10-12", "2026-10-18", 120)],
    });
    expect(await getAggregate("aggregate-monthly-2026")).toEqual({
      data: [dataPoint("2026-10-01", "2026-10-31", 840)],
    });
    expect(await getAggregate("aggregate-annual")).toEqual({
      data: [dataPoint("2026-01-01", "2026-12-31", 840)],
    });
    expect(await env.dispatch_kv.get("latestAggregatedDispatchDate")).toBe("2026-10-12");
  });

  it("doesn't aggregate files the daily sync hasn't finished with", async () => {
    await storeDailyFile("2026-10-05", 10);
    await storeDailyFile("2026-10-06", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261005");

    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2026-10")).toEqual({ data: [day("2026-10-05", 240)] });
    expect(await env.dispatch_kv.get("latestAggregatedDispatchDate")).toBe("2026-10-05");
  });

  it("only reads days after the last aggregated day on later runs", async () => {
    await storeDailyFile("2026-10-05", 10);
    await env.dispatch_kv.put("latestDailySyncDate", "20261005");
    await syncDispatchAggregates();

    // a change to an already aggregated day isn't picked up unless it's queued for re-aggregation
    await storeDailyFile("2026-10-05", 99);
    await storeDailyFile("2026-10-06", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261006");
    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2026-10")).toEqual({
      data: [day("2026-10-05", 240), day("2026-10-06", 480)],
    });
    expect(await getAggregate("aggregate-monthly-2026")).toEqual({
      data: [dataPoint("2026-10-01", "2026-10-31", 720)],
    });
    expect(await env.dispatch_kv.get("latestAggregatedDispatchDate")).toBe("2026-10-06");
  });

  it("totals a week spanning two months from both months' daily files", async () => {
    // Wednesday 30 September
    await storeDailyFile("2026-09-30", 10);
    await env.dispatch_kv.put("latestDailySyncDate", "20260930");
    await syncDispatchAggregates();

    // Thursday 1 October
    await storeDailyFile("2026-10-01", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261001");
    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2026-09")).toEqual({ data: [day("2026-09-30", 240)] });
    expect(await getAggregate("aggregate-daily-2026-10")).toEqual({ data: [day("2026-10-01", 480)] });
    expect(await getAggregate("aggregate-weekly-2026")).toEqual({
      data: [dataPoint("2026-09-28", "2026-10-04", 720)],
    });
    expect(await getAggregate("aggregate-monthly-2026")).toEqual({
      data: [dataPoint("2026-09-01", "2026-09-30", 240), dataPoint("2026-10-01", "2026-10-31", 480)],
    });
    expect(await getAggregate("aggregate-annual")).toEqual({
      data: [dataPoint("2026-01-01", "2026-12-31", 720)],
    });
  });

  it("recalculates queued days without moving the checkpoint backwards", async () => {
    await storeDailyFile("2026-10-05", 10);
    await storeDailyFile("2026-10-06", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261006");
    await syncDispatchAggregates();

    // EMI republished the 5th
    await storeDailyFile("2026-10-05", 30);
    await queueForReaggregation(["20261005"]);
    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2026-10")).toEqual({
      data: [day("2026-10-05", 720), day("2026-10-06", 480)],
    });
    expect(await getAggregate("aggregate-monthly-2026")).toEqual({
      data: [dataPoint("2026-10-01", "2026-10-31", 1200)],
    });
    expect(await env.dispatch_kv.get("latestAggregatedDispatchDate")).toBe("2026-10-06");
    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBe("[]");
  });

  it("records when new days were last aggregated, but not when only recalculating", async () => {
    const getLatest = () => env.dispatch_kv.getWithMetadata("latestAggregatedDispatchDate");
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(new Date("2026-10-07T08:02:00Z"));
    await storeDailyFile("2026-10-06", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261006");
    await syncDispatchAggregates();

    // EMI republished the 6th later that day
    vi.setSystemTime(new Date("2026-10-07T15:02:00Z"));
    await storeDailyFile("2026-10-06", 30);
    await queueForReaggregation(["20261006"]);
    await syncDispatchAggregates();

    expect(await getLatest()).toEqual({
      value: "2026-10-06",
      metadata: { updatedAt: new Date("2026-10-07T08:02:00Z").getTime() },
    });

    vi.setSystemTime(new Date("2026-10-08T08:02:00Z"));
    await storeDailyFile("2026-10-07", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261007");
    await syncDispatchAggregates();

    expect(await getLatest()).toEqual({
      value: "2026-10-07",
      metadata: { updatedAt: new Date("2026-10-08T08:02:00Z").getTime() },
    });
  });

  it("leaves the first, partial, day of dispatch files to metered generation", async () => {
    await storeDailyFile("2020-09-10", 10);
    await storeDailyFile("2020-09-11", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20200911");

    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2020-09")).toEqual({ data: [day("2020-09-11", 480)] });
    expect(await env.dispatch_kv.get("latestAggregatedDispatchDate")).toBe("2020-09-11");
  });

  it("skips queued days whose daily file no longer exists", async () => {
    await storeDailyFile("2026-10-06", 20);
    await env.dispatch_kv.put("latestDailySyncDate", "20261006");
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-05");
    await env.dispatch_kv.put("dispatchDatesToReaggregate", JSON.stringify(["2026-10-04"]));

    await syncDispatchAggregates();

    expect(await getAggregate("aggregate-daily-2026-10")).toEqual({ data: [day("2026-10-06", 480)] });
    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBe("[]");
  });
});

describe("queueForReaggregation", () => {
  it("does nothing before anything has been aggregated", async () => {
    await queueForReaggregation(["20261005"]);

    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBeNull();
  });

  it("ignores days that haven't been aggregated yet", async () => {
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-06");

    await queueForReaggregation(["20261007", "20261008"]);

    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBeNull();
  });

  it("ignores days aggregated from metered generation", async () => {
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-06");

    await queueForReaggregation(["20200910", "20200911"]);

    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBe(JSON.stringify(["2020-09-11"]));
  });

  it("adds aggregated days to the queue, in date order without duplicates", async () => {
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-06");
    await env.dispatch_kv.put("dispatchDatesToReaggregate", JSON.stringify(["2026-10-05"]));

    await queueForReaggregation(["20261005", "20261003", "20261007"]);

    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBe(JSON.stringify(["2026-10-03", "2026-10-05"]));
  });
});
