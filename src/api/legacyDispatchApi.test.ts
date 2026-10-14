import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { outage, rtd } from "../testing/fixtures";
import { getSubstations } from "../clients/substations";

async function getJson(path: string) {
  const { response } = await requestWorker(path);
  return { response, json: await response.json() as any };
}

describe("legacy dispatch api", () => {
  beforeEach(() => {
    // 22:01 in NZ
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:01:00Z"));
  });

  describe("GET /v1/dispatch/legacy/generators", () => {
    beforeEach(async () => {
      await env.dispatch_kv.put("latestDispatch", JSON.stringify([
        rtd("ATI2201 ATI0", 50, 0, 120.5),
        rtd("ALB0331", 0, 20, 130),
      ]));
      await env.dispatch_kv.put("latestOutages", JSON.stringify({ "ATI2201 ATI0": [outage("ATI_0")] }));
    });

    it("returns each unit's generation and outages", async () => {
      const { json } = await getJson("/v1/dispatch/legacy/generators");

      expect(json.lastUpdate).toBe("2026-10-14T22:00:00");
      expect(json.generators.find((generator: any) => generator.site === "ATI").units).toEqual([
        expect.objectContaining({
          node: "ATI2201 ATI0",
          generation: 50,
          outage: [{
            outageBlock: "ATI_0",
            mwLost: 84,
            mwRemain: 0,
            from: "2026-10-14T08:00:00Z",
            until: "2026-10-16T05:00:00Z",
          }],
        }),
      ]);
    });

    it("returns 0MW for units that aren't in the latest dispatch", async () => {
      const { json } = await getJson("/v1/dispatch/legacy/generators");

      expect(json.generators.find((generator: any) => generator.site === "ARI").units).toEqual([
        expect.objectContaining({ node: "ARI1101 ARI0", generation: 0, outage: [] }),
        expect.objectContaining({ node: "ARI1102 ARI0", generation: 0, outage: [] }),
      ]);
    });

    it("is cached until the next interval should be available", async () => {
      const { response } = await getJson("/v1/dispatch/legacy/generators");

      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });
  });

  describe("GET /v1/dispatch/legacy/nzgrid", () => {
    beforeEach(async () => {
      // every substation has a load on its 220kV bus
      const substationLoads = (await getSubstations()).map(substation => rtd(`${substation.siteId}2201`, 0, 10, 100));
      await env.dispatch_kv.put("latestDispatch", JSON.stringify([
        ...substationLoads,
        rtd("ATI2201 ATI0", 50, 0, 101),
        rtd("ATI2201 XYZ0", 5, 0, 101),
      ]));
    });

    it("totals each substation's busbars and generation", async () => {
      const { response, json } = await getJson("/v1/dispatch/legacy/nzgrid");

      expect(json.lastUpdated).toBe("2026-10-14T22:00:00");
      expect(json.sites).toHaveLength((await getSubstations()).length);
      expect(json.sites.find((site: any) => site.siteId === "ATI")).toMatchObject({
        busbars: {
          "220kV - 1": {
            connections: [
              { identifier: "ATI2201", loadMW: 10, generationMW: 0, generatorInfo: {} },
              {
                identifier: "ATI2201 ATI0",
                loadMW: 0,
                generationMW: 50,
                generatorInfo: { plantName: "Ātiamuri", operator: "Mercury", technology: "", fuel: "Hydro", nameplateCapacityMW: 84 },
              },
              { identifier: "ATI2201 XYZ0", loadMW: 0, generationMW: 5, generatorInfo: { plantName: "Unknown" } },
            ],
            priceDollarsPerMegawattHour: 101,
            voltage: "220",
            busNumber: "1",
            totalGenerationMW: 55,
            totalLoadMW: 10,
            netImportMW: -45,
          },
        },
        totalGenerationMW: 55,
        totalLoadMW: 10,
        netImportMW: -45,
        totalGenerationCapacityMW: 84,
      });
      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });
  });

  describe("GET /v1/dispatch/legacy/history/generation/:date", () => {
    it("returns each generator unit's output from the day's dispatch file", async () => {
      await env.dispatch.put("dispatch-20261012", JSON.stringify({
        "2026-10-12T00:00:00": [
          { p: "ATI2201 ATI0", g: "50", l: "1", c: "120" },
          // the same unit from a second run in the interval
          { p: "ATI2201 ATI0", g: "60", l: "0", c: "120" },
          // not a generator
          { p: "ALB0331", g: "0", l: "20", c: "130" },
          // a unit missing from the definitions
          { p: "XYZ2201 XYZ0", g: "10", l: "0", c: "120" },
        ],
      }));

      const { response, json } = await getJson("/v1/dispatch/legacy/history/generation/2026-10-12");

      expect(json).toEqual({
        "2026-10-12T00:00:00": [{ site: "ATI", fuel: "HYD", gen: 49, node: "ATI2201 ATI0" }],
      });
      expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
    });

    it("falls back to the recent timeseries for days that haven't been synced yet, totalled by site and fuel", async () => {
      await env.dispatch.put("timeseries", JSON.stringify({
        series: ["ATI2201 ATI0", "ARI1101 ARI0", "ARI1102 ARI0"],
        data: [
          ["2026-10-13T23:55:00", 1, 2, 3],
          ["2026-10-14T00:00:00", 50, 30, 40],
          ["2026-10-14T21:55:00", 51, 31, 41],
        ],
        pricing: [],
      }));

      const { response, json } = await getJson("/v1/dispatch/legacy/history/generation/2026-10-14");

      expect(Object.keys(json)).toEqual(["2026-10-14T00:00:00", "2026-10-14T21:55:00"]);
      expect(json["2026-10-14T00:00:00"]).toContainEqual({ site: "ATI", fuel: "HYD", gen: 50 });
      expect(json["2026-10-14T00:00:00"]).toContainEqual({ site: "ARI", fuel: "HYD", gen: 70 });
      // units missing from the timeseries are 0MW
      expect(json["2026-10-14T00:00:00"]).toContainEqual({ site: "TAM", fuel: "GEO", gen: 0 });
      // the 22:00 interval is expected by 22:00, so is already due
      expect(response.headers.get("Cache-Control")).toBe("max-age=0");
    });

    it("returns 404 when there's no data for the day", async () => {
      await env.dispatch.put("timeseries", JSON.stringify({ series: [], data: [], pricing: [] }));

      const { response } = await getJson("/v1/dispatch/legacy/history/generation/2026-10-01");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /v1/dispatch/legacy/history/price/:date", () => {
    it("returns the Otahuhu and Benmore prices from the day's dispatch file", async () => {
      await env.dispatch.put("dispatch-20261012", JSON.stringify({
        "2026-10-12T00:00:00": [
          { p: "OTA2201", g: "0", l: "100", c: "120" },
          { p: "BEN2202", g: "0", l: "0", c: "95" },
          { p: "ALB0331", g: "0", l: "20", c: "130" },
        ],
      }));

      const { response, json } = await getJson("/v1/dispatch/legacy/history/price/2026-10-12");

      expect(json).toEqual({ "2026-10-12T00:00:00": { OTA2201: 120, BEN2201: 95 } });
      expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
    });

    it("falls back to the recent timeseries for days that haven't been synced yet", async () => {
      await env.dispatch.put("timeseries", JSON.stringify({
        series: ["ALB0331", "BEN2201", "OTA2201"],
        data: [],
        pricing: [
          ["2026-10-13T23:55:00", 1, 2, 3],
          ["2026-10-14T22:00:00", 130, 95, 120],
        ],
      }));

      const { response, json } = await getJson("/v1/dispatch/legacy/history/price/2026-10-14");

      expect(json).toEqual({ "2026-10-14T22:00:00": { OTA2201: 120, BEN2201: 95 } });
      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });

    it("returns 404 when there's no data for the day", async () => {
      const { response } = await getJson("/v1/dispatch/legacy/history/price/2026-10-01");

      expect(response.status).toBe(404);
    });
  });
});
