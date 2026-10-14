import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { syncDispatch } from "./syncDispatch";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { mockFetch } from "../testing/fetchMock";
import { EMI_RTD_URL, outage, POCP_OUTAGES_URL, rtd } from "../testing/fixtures";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import { PocpOutage } from "../models/pocpOutage";

const latestDispatch = [
  rtd("ATI2201 ATI0", 50, 0, 120.5),
  rtd("ALB0331", 0, 20, 130),
];

function mockApis({ dispatch = latestDispatch, dispatchStatus = 200, outages = [outage("ATI_0")] as PocpOutage[], outagesStatus = 200 } = {}) {
  return mockFetch({
    [EMI_RTD_URL]: () => Response.json(dispatch, { status: dispatchStatus }),
    [POCP_OUTAGES_URL]: () => Response.json({ items: outages }, { status: outagesStatus }),
    [env.SLACK_WEBHOOK_URL as string]: () => new Response("ok"),
  });
}

async function getJson(bucket: R2Bucket, key: string) {
  return await (await bucket.get(key))?.json();
}

describe("syncDispatch", () => {
  beforeEach(() => {
    // 22:01 in NZ
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:01:00Z"));
  });

  it("skips syncing within 5 minutes of the last interval", async () => {
    await env.dispatch_kv.put("latestDispatchTime", JSON.stringify("2026-10-14T21:57:00"));
    const requests = mockApis();

    await syncDispatch();

    expect(requests).toEqual([]);
  });

  it("stores the latest dispatch and starts the timeseries on the first sync", async () => {
    const requests = mockApis();

    await syncDispatch();

    expect(requests[0].headers.get("Ocp-Apim-Subscription-Key")).toBe(env.EMI_API_KEY);
    expect(await env.dispatch_kv.get("latestDispatchTime")).toBe(JSON.stringify("2026-10-14T22:00:00"));
    expect(JSON.parse((await env.dispatch_kv.get("latestDispatch"))!)).toEqual(latestDispatch);
    expect(await getJson(env.dispatch, "timeseries")).toEqual({
      series: ["ATI2201 ATI0", "ALB0331"],
      data: [["2026-10-14T22:00:00", 50, -20]],
      pricing: [["2026-10-14T22:00:00", 120.5, 130]],
    });
  });

  it("appends new intervals to the existing timeseries", async () => {
    await env.dispatch_kv.put("latestDispatchTime", JSON.stringify("2026-10-14T21:55:00"));
    await env.dispatch.put("timeseries", JSON.stringify({
      series: ["ATI2201 ATI0", "ALB0331"],
      data: [["2026-10-14T21:55:00", 45, -18]],
      pricing: [["2026-10-14T21:55:00", 110, 115]],
    }));
    mockApis();

    await syncDispatch();

    expect(await getJson(env.dispatch, "timeseries")).toEqual({
      series: ["ATI2201 ATI0", "ALB0331"],
      data: [["2026-10-14T21:55:00", 45, -18], ["2026-10-14T22:00:00", 50, -20]],
      pricing: [["2026-10-14T21:55:00", 110, 115], ["2026-10-14T22:00:00", 120.5, 130]],
    });
  });

  it("doesn't rewrite the dispatch when EMI hasn't published a new interval yet", async () => {
    await env.dispatch_kv.put("latestDispatchTime", JSON.stringify("2026-10-14T21:55:00"));
    const stale = [rtd("ATI2201 ATI0", 45, 0, 110, "2026-10-14T21:55:00")];
    mockApis({ dispatch: stale });

    await syncDispatch();

    expect(await env.dispatch.get("timeseries")).toBeNull();
    expect(await env.dispatch_kv.get("latestDispatch")).toBeNull();
  });

  it("stores the generation outages by unit", async () => {
    const outages = [outage("ATI_0"), outage("NOT_A_UNIT")];
    const requests = mockApis({ outages });

    await syncDispatch();

    const pocpUrl = new URL(requests.find(request => request.url.startsWith(POCP_OUTAGES_URL))!.url);
    expect(pocpUrl.searchParams.getAll("planningStatus")).toEqual(["CONFIRMED", "COMPLETED"]);
    expect(pocpUrl.searchParams.getAll("category")).toEqual(["GENERATION", "EMBEDDED_GENERATION"]);
    expect(JSON.parse((await env.dispatch_kv.get("latestOutages"))!)).toEqual({
      "ATI2201 ATI0": [outages[0]],
    });
  });

  it.each([
    { problem: "returns an error", outagesStatus: 500, outages: [outage("HLY_1")] },
    { problem: "returns no outages", outagesStatus: 200, outages: [] },
  ])("keeps the cached outages when POCP $problem", async ({ outagesStatus, outages }) => {
    const cachedOutages = JSON.stringify({ "ATI2201 ATI0": [outage("ATI_0")] });
    await env.dispatch_kv.put("latestOutages", cachedOutages);
    mockApis({ outagesStatus, outages });

    await syncDispatch();

    expect(await env.dispatch_kv.get("latestOutages")).toBe(cachedOutages);
    // the dispatch is still synced
    expect(await env.dispatch_kv.get("latestDispatchTime")).toBe(JSON.stringify("2026-10-14T22:00:00"));
  });

  it("still refreshes outages when the EMI API fails", async () => {
    mockApis({ dispatchStatus: 500, outages: [outage("ATI_0")] });

    await syncDispatch();

    expect(await env.dispatch_kv.get("latestDispatchTime")).toBeNull();
    expect(await env.dispatch.get("timeseries")).toBeNull();
    expect(JSON.parse((await env.dispatch_kv.get("latestOutages"))!)).toHaveProperty("ATI2201 ATI0");
  });

  describe("missing units", () => {
    const unknownUnit = rtd("XYZ2201 XYZ0", 10, 0, 100);

    function slackRequests(requests: Request[]) {
      return requests.filter(request => request.url === env.SLACK_WEBHOOK_URL);
    }

    async function storeMissingUnitsFor(dispatch: RealTimeDispatch[]) {
      const missingUnits = await checkForMissingUnits(dispatch.map(item => item.PointOfConnectionCode));
      await env.dispatch_kv.put("missingUnit", JSON.stringify(missingUnits));
    }

    it("records missing units without notifying on the first sync", async () => {
      const requests = mockApis({ dispatch: [...latestDispatch, unknownUnit] });

      await syncDispatch();

      expect(slackRequests(requests)).toEqual([]);
      const missingUnits = JSON.parse((await env.dispatch_kv.get("missingUnit"))!);
      expect(missingUnits.generation.notInGeneratorList).toEqual(["XYZ2201 XYZ0"]);
    });

    it("notifies Slack when the missing units change", async () => {
      await storeMissingUnitsFor(latestDispatch);
      const requests = mockApis({ dispatch: [...latestDispatch, unknownUnit] });

      await syncDispatch();

      const [slackRequest] = slackRequests(requests);
      expect(slackRequest.method).toBe("POST");
      expect((await slackRequest.json() as { text: string }).text).toContain("Missing unit in generator list: `XYZ2201 XYZ0`");
    });

    it("doesn't notify Slack when the missing units are unchanged", async () => {
      await storeMissingUnitsFor([...latestDispatch, unknownUnit]);
      const requests = mockApis({ dispatch: [...latestDispatch, unknownUnit] });

      await syncDispatch();

      expect(slackRequests(requests)).toEqual([]);
    });
  });
});
