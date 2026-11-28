import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { outage } from "../testing/fixtures";
import { getGenerators } from "../clients/generators";
import { METERED_DAY_PREFIX } from "../services/meteredGeneration/meteredGeneration";

async function getJson(path: string) {
  const { response } = await requestWorker(path);
  return { response, json: (await response.json()) as any };
}

const unitIn = (json: any, node: string) => json.units.find((unit: any) => unit.node === node);

// Huntly's units out of generators.json's order, with a node of another station's and some of Huntly's missing (HLY6,
// HLY2 and HLY4, as if they hadn't been dispatched in the last few days, and the retired HLY3 and huntly_1_4)
const TIMESERIES = {
  series: ["HLY2201 HLY5", "ALB0331", "HLY2201 HLY91", "HLY2201 HLY1", "HLY2201 HLY11"],
  data: [
    ["2026-10-13T23:55:00", 400, -20, 0, 200, 0],
    ["2026-10-14T21:50:00", 380, -20, -50, 240, 0],
    ["2026-10-14T21:55:00", 390, -21, -100, 240, 0],
    ["2026-10-14T22:00:00", 382, -22, 0, 240, 60],
  ],
  pricing: [
    ["2026-10-13T23:55:00", 100, 101, 100, 100, 100],
    ["2026-10-14T21:50:00", 150, 151, 150, 150, 150],
    ["2026-10-14T21:55:00", 160, 161, 160, 160, 160],
    ["2026-10-14T22:00:00", 182.4, 183, 182.4, 182.4, 182.4],
  ],
};

// the units Huntly had in service in October 2026, in generators.json's order
const HUNTLY_IN_SERVICE = [
  "HLY2201 HLY5",
  "HLY2201 HLY6",
  "HLY2201 HLY1",
  "HLY2201 HLY2",
  "HLY2201 HLY4",
  "HLY2201 HLY11",
  "HLY2201 HLY91",
];

// one going on today (14 October), and one on the 12th
const OUTAGES = {
  "HLY2201 HLY5": [outage("HLY_5", { mwattLost: 403 })],
  "HLY2201 HLY1": [
    outage("HLY_1", { timeStart: "2026-10-11T20:00:00Z", timeEnd: "2026-10-12T02:00:00Z" }),
  ],
};

describe("generators api", () => {
  beforeEach(async () => {
    // 22:01 in NZ
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:01:00Z"));
    await env.dispatch.put("timeseries", JSON.stringify(TIMESERIES));
    await env.dispatch_kv.put("latestOutages", JSON.stringify(OUTAGES));
  });

  describe("GET /v1/generators", () => {
    it("returns every station", async () => {
      const { response, json } = await getJson("/v1/generators");

      expect(json).toEqual(await getGenerators());
      expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
    });
  });

  describe("GET /v1/generators/{site}", () => {
    it("returns today's intervals for the station's units in service, in the order they're defined", async () => {
      const { json } = await getJson("/v1/generators/HLY");

      expect(json.date).toBe("2026-10-14");
      expect(json.live).toBe(true);
      expect(json.lastUpdated).toBe("2026-10-14T22:00:00");
      // the units the live dispatch has no column for are 0, with no price
      expect(json.dispatch).toEqual({
        series: HUNTLY_IN_SERVICE,
        data: [
          ["2026-10-14T21:50:00", 380, 0, 240, 0, 0, 0, -50],
          ["2026-10-14T21:55:00", 390, 0, 240, 0, 0, 0, -100],
          ["2026-10-14T22:00:00", 382, 0, 240, 0, 0, 60, 0],
        ],
        pricing: [
          ["2026-10-14T21:50:00", 150, null, 150, null, null, 150, 150],
          ["2026-10-14T21:55:00", 160, null, 160, null, null, 160, 160],
          ["2026-10-14T22:00:00", 182.4, null, 182.4, null, null, 182.4, 182.4],
        ],
      });
    });

    it("returns the station's definition, with each unit's day so far and outages", async () => {
      const { json } = await getJson("/v1/generators/HLY");
      const { units, ...station } = (await getGenerators()).find((g) => g.site === "HLY")!;

      expect(json).toMatchObject(station);
      expect(json.units.map((unit: any) => unit.node)).toEqual(units.map((unit) => unit.node));
      expect(unitIn(json, "HLY2201 HLY5")).toEqual({
        ...units.find((unit) => unit.node === "HLY2201 HLY5"),
        summary: {
          // a mean of 384MW over the 22h05m from 00:00 to the end of 22:00's interval
          energy: 8480,
          peak: { mw: 390, time: "2026-10-14T21:55:00" },
          latest: { mw: 382, price: 182.4 },
        },
        outages: [
          {
            outageBlock: "HLY_5",
            mwLost: 403,
            mwRemain: 0,
            from: "2026-10-14T08:00:00Z",
            until: "2026-10-16T05:00:00Z",
          },
        ],
      });
      // its first interval at its highest
      expect(unitIn(json, "HLY2201 HLY1").summary.peak).toEqual({
        mw: 240,
        time: "2026-10-14T21:50:00",
      });
      // the 12th's outage isn't going on today
      expect(unitIn(json, "HLY2201 HLY1").outages).toEqual([]);
      expect(unitIn(json, "HLY2201 HLY6").summary).toEqual({
        energy: 0,
        peak: { mw: 0, time: "2026-10-14T21:50:00" },
        latest: { mw: 0, price: null },
      });
    });

    it("gives a battery's charging node its most negative interval as its peak", async () => {
      const { json } = await getJson("/v1/generators/HLY");

      expect(unitIn(json, "HLY2201 HLY91").summary).toEqual({
        energy: -1104.167,
        peak: { mw: -100, time: "2026-10-14T21:55:00" },
        latest: { mw: 0, price: 182.4 },
      });
    });

    it("leaves the summary off units that aren't in service", async () => {
      const { json } = await getJson("/v1/generators/HLY");
      const retired = unitIn(json, "HLY2201 HLY3");

      expect(retired.decomissioned).toBeDefined();
      expect(retired).not.toHaveProperty("summary");
      expect(retired.outages).toEqual([]);
    });

    it("sums the units into the station's day so far", async () => {
      const { json } = await getJson("/v1/generators/HLY");

      // the totals are 570, 530 and 682, a mean of 594MW
      expect(json.summary).toEqual({
        energy: 13117.5,
        peak: { mw: 682, time: "2026-10-14T22:00:00" },
      });
    });

    it("has no intervals or summaries before today's first interval", async () => {
      await env.dispatch.put(
        "timeseries",
        JSON.stringify({
          series: TIMESERIES.series,
          data: TIMESERIES.data.slice(0, 1),
          pricing: TIMESERIES.pricing.slice(0, 1),
        }),
      );

      const { json } = await getJson("/v1/generators/HLY");

      expect(json.lastUpdated).toBe("2026-10-13T23:55:00");
      expect(json.dispatch).toEqual({ series: HUNTLY_IN_SERVICE, data: [], pricing: [] });
      expect(json).not.toHaveProperty("summary");
      expect(json.units.some((unit: any) => "summary" in unit)).toBe(false);
    });

    it("is cached until the next interval should be available", async () => {
      const { response } = await getJson("/v1/generators/HLY");

      // the next interval is expected by 22:06, 5 minutes from now
      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });

    it("finds the station by its site code in any case, or its alias", async () => {
      expect((await getJson("/v1/generators/hly")).json.site).toBe("HLY");
      expect((await getJson("/v1/generators/tcc")).json.site).toBe("SFD");
    });

    it("returns 404 for a site code no station has", async () => {
      const { response, json } = await getJson("/v1/generators/XYZ");

      expect(response.status).toBe(404);
      expect(json).toEqual({ message: "No generator with this site code" });
    });

    it("returns 503 before the live dispatch has been synced", async () => {
      await env.dispatch.delete("timeseries");

      const { response, json } = await getJson("/v1/generators/HLY");

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(json).toEqual({ message: "Live dispatch data is temporarily unavailable" });
    });
  });

  describe("GET /v1/generators/{site}/{date}", () => {
    it.each(["2026-10-14", "20261014"])(
      "returns the same as /v1/generators/{site} for today (%s)",
      async (date) => {
        const today = await getJson("/v1/generators/HLY");
        const { response, json } = await getJson(`/v1/generators/HLY/${date}`);

        expect(json).toEqual(today.json);
        expect(response.headers.get("Cache-Control")).toBe("max-age=300");
      },
    );

    it("returns today from the live dispatch even if a file has the date", async () => {
      await env.dispatch.put(
        "dispatch-20261014",
        JSON.stringify({ "2026-10-14T00:00:00": [{ p: "HLY2201 HLY5", g: 1, l: 0, c: 1 }] }),
      );

      const { json } = await getJson("/v1/generators/HLY/2026-10-14");

      expect(json.live).toBe(true);
      expect(json.dispatch.data).toHaveLength(3);
    });

    it("returns 503 for today before the live dispatch has been synced", async () => {
      await env.dispatch.delete("timeseries");

      const { response } = await getJson("/v1/generators/HLY/2026-10-14");

      expect(response.status).toBe(503);
    });

    it("falls back to the live dispatch for a day EMI hasn't published yet", async () => {
      const { response, json } = await getJson("/v1/generators/HLY/2026-10-13");

      expect(json.date).toBe("2026-10-13");
      expect(json.live).toBe(true);
      expect(json.lastUpdated).toBe("2026-10-14T22:00:00");
      expect(json.dispatch).toEqual({
        series: HUNTLY_IN_SERVICE,
        data: [["2026-10-13T23:55:00", 400, 0, 200, 0, 0, 0, 0]],
        pricing: [["2026-10-13T23:55:00", 100, null, 100, null, null, 100, 100]],
      });
      // to the end of 23:55's interval, the whole day
      expect(unitIn(json, "HLY2201 HLY5").summary.energy).toBe(400 * 24);
      expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    });

    describe("a day EMI has published", () => {
      beforeEach(async () => {
        await env.dispatch.put(
          "dispatch-20261012",
          JSON.stringify({
            "2026-10-12T00:00:00": [
              { p: "HLY2201 HLY5", g: 300, l: 0, c: 100 },
              { p: "ALB0331", g: 0, l: 20, c: 101 },
            ],
            "2026-10-12T00:05:00": [
              { p: "HLY2201 HLY5", g: 340, l: 0, c: 110 },
              { p: "HLY2201 HLY91", g: 0, l: 40, c: 110 },
            ],
          }),
        );
      });

      it("returns the units' intervals from its file, with the units it leaves out at 0", async () => {
        const { json } = await getJson("/v1/generators/HLY/2026-10-12");

        expect(json.live).toBe(false);
        expect(json).not.toHaveProperty("lastUpdated");
        expect(json.dispatch).toEqual({
          series: HUNTLY_IN_SERVICE,
          data: [
            ["2026-10-12T00:00:00", 300, 0, 0, 0, 0, 0, 0],
            ["2026-10-12T00:05:00", 340, 0, 0, 0, 0, 0, -40],
          ],
          pricing: [
            ["2026-10-12T00:00:00", 100, null, null, null, null, null, null],
            ["2026-10-12T00:05:00", 110, null, null, null, null, null, 110],
          ],
        });
      });

      it("summarises the whole day, from the mean of the intervals it has", async () => {
        const { json } = await getJson("/v1/generators/HLY/2026-10-12");

        expect(unitIn(json, "HLY2201 HLY5").summary).toEqual({
          energy: 320 * 24,
          peak: { mw: 340, time: "2026-10-12T00:05:00" },
          latest: { mw: 340, price: 110 },
        });
        expect(unitIn(json, "HLY2201 HLY91").summary.energy).toBe(-20 * 24);
        expect(json.summary).toEqual({
          energy: 300 * 24,
          peak: { mw: 300, time: "2026-10-12T00:00:00" },
        });
      });

      it("returns the outages going on that day", async () => {
        const { json } = await getJson("/v1/generators/HLY/2026-10-12");

        expect(unitIn(json, "HLY2201 HLY1").outages).toEqual([
          {
            outageBlock: "HLY_1",
            mwLost: 84,
            mwRemain: 0,
            from: "2026-10-11T20:00:00Z",
            until: "2026-10-12T02:00:00Z",
          },
        ]);
        expect(unitIn(json, "HLY2201 HLY5").outages).toEqual([]);
      });

      it("is cached for an hour while its outages can still be revised", async () => {
        const { response } = await getJson("/v1/generators/HLY/2026-10-12");

        expect(response.headers.get("Cache-Control")).toBe("max-age=3600");
      });
    });

    it("leaves out the outages of a day before the last 14, and caches it for a day", async () => {
      await env.dispatch.put(
        "dispatch-20250115",
        JSON.stringify({ "2025-01-15T00:00:00": [{ p: "HLY2201 HLY5", g: 300, l: 0, c: 100 }] }),
      );

      const { response, json } = await getJson("/v1/generators/HLY/2025-01-15");

      expect(json.units.some((unit: any) => "outages" in unit)).toBe(false);
      expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
    });

    it("returns the metered generation by trading period before the dispatch data, without prices", async () => {
      await env.dispatch.put(
        `${METERED_DAY_PREFIX}19980601`,
        JSON.stringify({
          "1998-06-01T00:00:00": [{ p: "HLY2201 huntly_1_4", g: 500, l: 0 }],
          "1998-06-01T00:30:00": [{ p: "HLY2201 huntly_1_4", g: 700, l: 0 }],
        }),
      );

      const { json } = await getJson("/v1/generators/HLY/1998-06-01");

      // Rankine 1-4 were in service, but the metered data has them combined
      expect(json.dispatch).toEqual({
        series: ["HLY2201 huntly_1_4"],
        data: [
          ["1998-06-01T00:00:00", 500],
          ["1998-06-01T00:30:00", 700],
        ],
        pricing: [
          ["1998-06-01T00:00:00", null],
          ["1998-06-01T00:30:00", null],
        ],
      });
      expect(unitIn(json, "HLY2201 huntly_1_4").summary).toEqual({
        energy: 600 * 24,
        peak: { mw: 700, time: "1998-06-01T00:30:00" },
        latest: { mw: 700, price: null },
      });
    });

    it.each([
      ["a past day with no file that the live dispatch doesn't have", "2026-10-01"],
      ["a day that hasn't happened yet", "2026-10-15"],
    ])("returns 404 for %s", async (_, date) => {
      const { response, json } = await getJson(`/v1/generators/HLY/${date}`);

      expect(response.status).toBe(404);
      expect(json).toEqual({ message: "No data for this date" });
    });

    it("returns 404 for a past day with no file before the live dispatch has been synced", async () => {
      await env.dispatch.delete("timeseries");

      const { response } = await getJson("/v1/generators/HLY/2026-10-13");

      expect(response.status).toBe(404);
    });

    it("returns 404 for a site code no station has", async () => {
      const { response, json } = await getJson("/v1/generators/XYZ/2026-10-14");

      expect(response.status).toBe(404);
      expect(json).toEqual({ message: "No generator with this site code" });
    });

    it.each(["2026-02-30", "2026-1014", "today"])("returns 400 for %s", async (date) => {
      const { response, json } = await getJson(`/v1/generators/HLY/${date}`);

      expect(response.status).toBe(400);
      expect(json).toEqual({ message: "Invalid date, expected an NZ date like 2026-10-14" });
    });
  });
});
