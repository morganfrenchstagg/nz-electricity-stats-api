import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { mockFetch } from "../testing/fetchMock";
import { EMI_RTD_URL, outage, rtd } from "../testing/fixtures";
import { getSubstations } from "../clients/substations";
import { getGenerators } from "../clients/generators";

const latestDispatch = [
  rtd("ATI2201 ATI0", 50, 0, 120.5),
  rtd("ALB0331", 0, 20, 130),
];

async function getJson(path: string) {
  const { response } = await requestWorker(path);
  return { response, json: await response.json() as any };
}

describe("dispatch api", () => {
  beforeEach(() => {
    // 22:01 in NZ
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:01:00Z"));
  });

  it.each(["/v1/dispatch/latest", "/v1/dispatch/delta"])("%s returns 503 before the live dispatch has been synced", async (path) => {
    const { response, json } = await getJson(path);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({ message: "Live dispatch data is temporarily unavailable" });
  });

  describe("GET /v1/dispatch/latest", () => {
    beforeEach(async () => {
      await env.dispatch_kv.put("latestDispatch", JSON.stringify(latestDispatch));
      await env.dispatch_kv.put("latestOutages", JSON.stringify({ "ATI2201 ATI0": [outage("ATI_0")] }));
    });

    it("returns each substation with its points of connection", async () => {
      const { json } = await getJson("/v1/dispatch/latest");

      expect(json.lastUpdated).toBe("2026-10-14T22:00:00");
      expect(json.substations).toHaveLength((await getSubstations()).length);
      expect(json.substations.find((substation: any) => substation.siteId === "ALB")).toEqual({
        ...(await getSubstations()).find(substation => substation.siteId === "ALB"),
        pointsOfConnection: [{ pointOfConnectionCode: "ALB0331", load: 20, generation: 0, price: 130 }],
      });
    });

    it("returns each generator unit with its dispatch and outages", async () => {
      const { json } = await getJson("/v1/dispatch/latest");

      expect(json.generators).toHaveLength((await getGenerators()).length);
      expect(json.generators.find((generator: any) => generator.site === "ATI").units).toEqual([{
        name: "Ātiamuri",
        unitCode: "ATI0",
        node: "ATI2201 ATI0",
        capacity: 84,
        fuel: "Hydro",
        fuelCode: "HYD",
        commissioned: "1899-12-31T12:30:00.000Z",
        dispatch: { load: 0, generation: 50, price: 120.5 },
        outages: [{
          outageBlock: "ATI_0",
          mwLost: 84,
          mwRemain: 0,
          from: "2026-10-14T08:00:00Z",
          until: "2026-10-16T05:00:00Z",
        }],
      }]);
    });

    it("leaves out dispatch for units that aren't in the latest dispatch", async () => {
      const { json } = await getJson("/v1/dispatch/latest");

      const [unit] = json.generators.find((generator: any) => generator.site === "ARI").units;
      expect(unit).not.toHaveProperty("dispatch");
      expect(unit.outages).toEqual([]);
    });
  });

  describe("GET /v1/dispatch/delta", () => {
    it("lists units missing from the definitions or the latest dispatch", async () => {
      await env.dispatch_kv.put("latestDispatch", JSON.stringify([...latestDispatch, rtd("XYZ2201 XYZ0", 10, 0, 100)]));

      const { json } = await getJson("/v1/dispatch/delta");

      expect(json.lastUpdated).toBe("2026-10-14T22:00:00");
      expect(json.missingUnits.generation.notInGeneratorList).toEqual(["XYZ2201 XYZ0"]);
      expect(json.missingUnits.generation.notInDispatchList).toContain("ARI1101 ARI0");
    });
  });

  describe("GET /v1/dispatch/rtd", () => {
    it("returns the real time dispatch straight from EMI", async () => {
      const requests = mockFetch({ [EMI_RTD_URL]: () => Response.json(latestDispatch) });

      const { json } = await getJson("/v1/dispatch/rtd");

      expect(json).toEqual(latestDispatch);
      expect(requests[0].headers.get("Ocp-Apim-Subscription-Key")).toBe(env.EMI_API_KEY);
    });
  });

  describe("GET /v1/dispatch/recent", () => {
    const timeseries = (latest: string) => ({
      series: ["ATI2201 ATI0"],
      data: [["2026-10-14T21:45:00", 48], [latest, 50]],
      pricing: [["2026-10-14T21:45:00", 110], [latest, 120.5]],
    });

    it("returns the recent timeseries, cached until the next interval should be available", async () => {
      await env.dispatch.put("timeseries", JSON.stringify(timeseries("2026-10-14T22:00:00")));

      const { response, json } = await getJson("/v1/dispatch/recent");

      expect(json).toEqual(timeseries("2026-10-14T22:00:00"));
      // the next interval is expected by 22:06, 5 minutes from now
      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });

    it("is cached briefly when the next interval is overdue", async () => {
      await env.dispatch.put("timeseries", JSON.stringify(timeseries("2026-10-14T21:50:00")));

      const { response } = await getJson("/v1/dispatch/recent");

      expect(response.headers.get("Cache-Control")).toBe("max-age=30");
    });

    it("returns an empty timeseries before anything has been synced", async () => {
      const { response, json } = await getJson("/v1/dispatch/recent");

      expect(response.status).toBe(200);
      expect(json).toEqual({ series: [], data: [], pricing: [] });
    });
  });

  describe("GET /v1/dispatch/:date", () => {
    beforeEach(async () => {
      await env.dispatch.put("dispatch-20261012", JSON.stringify({
        "2026-10-12T00:00:00": [
          { p: "ATI2201 ATI0", g: "50", l: "0", c: "120.5" },
          { p: "ALB0331", g: "0", l: "20", c: "130" },
        ],
        "2026-10-12T00:05:00": [
          { p: "ATI2201 ATI0", g: "52", l: "0", c: "118" },
        ],
      }));
    });

    it("returns the day's dispatch as a timeseries, with nodes missing from an interval at 0MW", async () => {
      const { response, json } = await getJson("/v1/dispatch/2026-10-12");

      expect(json).toEqual({
        series: ["ATI2201 ATI0", "ALB0331"],
        data: [
          ["2026-10-12T00:00:00", 50, -20],
          ["2026-10-12T00:05:00", 52, 0],
        ],
        pricing: [
          ["2026-10-12T00:00:00", 120.5, 130],
          ["2026-10-12T00:05:00", 118, null],
        ],
      });
      expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
    });

    it("accepts dates without dashes", async () => {
      const { json } = await getJson("/v1/dispatch/20261012");

      expect(json.series).toEqual(["ATI2201 ATI0", "ALB0331"]);
    });

    it("returns 404 for a day that hasn't been synced", async () => {
      const { response, json } = await getJson("/v1/dispatch/2026-10-13");

      expect(response.status).toBe(404);
      expect(json).toEqual({ message: "No data for this date" });
    });
  });
});
