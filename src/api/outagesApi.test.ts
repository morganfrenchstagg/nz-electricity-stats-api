import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { mockFetch } from "../testing/fetchMock";
import { outage, POCP_OUTAGES_URL } from "../testing/fixtures";
import { PocpOutage } from "../models/pocpOutage";

const NOW = new Date("2026-11-26T09:00:00Z").getTime();

function mockPocp(outages: PocpOutage[] | null, status = 200) {
  return mockFetch({
    [POCP_OUTAGES_URL]: () => Response.json(outages === null ? {} : { items: outages }, { status }),
  });
}

describe("outages api", () => {
  it("returns the current outages for each unit, cached for an hour", async () => {
    await env.dispatch_kv.put(
      "latestOutages",
      JSON.stringify({
        "ATI2201 ATI0": [outage("ATI_0", { mwattLost: 40, mwattRemaining: 44 })],
      }),
    );

    const { response } = await requestWorker("/v1/outages");

    expect(await response.json()).toEqual({
      "ATI2201 ATI0": [
        {
          outageBlock: "ATI_0",
          timeStart: "2026-10-14T08:00:00Z",
          timeEnd: "2026-10-16T05:00:00Z",
          mwattLost: 40,
        },
      ],
    });
    expect(response.headers.get("Cache-Control")).toBe("max-age=3600");
  });

  it("returns no outages before they've been synced", async () => {
    const { response } = await requestWorker("/v1/outages");

    expect(await response.json()).toEqual({});
  });

  describe("for a day", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    it("returns the outages going on at any time in the NZ day, for each unit", async () => {
      // POCP widens the window it's asked for, so it also returns outages that ended before the day or start after it
      const requests = mockPocp([
        outage("ATI_0", {
          timeStart: "2026-06-10T08:00:00+12:00",
          timeEnd: "2026-06-10T17:00:00+12:00",
          mwattLost: 40,
        }),
        outage("HLY_5", {
          timeStart: "2024-10-29T07:00:00+13:00",
          timeEnd: "2027-04-30T17:00:00+12:00",
          mwattLost: 400,
        }),
        outage("HLY_1", {
          timeStart: "2026-06-09T08:00:00+12:00",
          timeEnd: "2026-06-10T00:00:00+12:00",
        }),
        outage("HLY_2", {
          timeStart: "2026-06-11T00:00:00+12:00",
          timeEnd: "2026-06-11T17:00:00+12:00",
        }),
      ]);

      const { response } = await requestWorker("/v1/outages/2026-06-10");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        "ATI2201 ATI0": [
          {
            outageBlock: "ATI_0",
            timeStart: "2026-06-10T08:00:00+12:00",
            timeEnd: "2026-06-10T17:00:00+12:00",
            mwattLost: 40,
          },
        ],
        "HLY2201 HLY5": [
          {
            outageBlock: "HLY_5",
            timeStart: "2024-10-29T07:00:00+13:00",
            timeEnd: "2027-04-30T17:00:00+12:00",
            mwattLost: 400,
          },
        ],
      });
      const params = new URL(requests[0].url).searchParams;
      expect(params.get("outageAtFrom")).toBe("2026-06-09T12:00:00.000Z");
      expect(params.get("outageAtTo")).toBe("2026-06-10T12:00:00.000Z");
      expect(params.getAll("planningStatus")).toEqual(["CONFIRMED", "COMPLETED"]);
      expect(params.getAll("category")).toEqual(["GENERATION", "EMBEDDED_GENERATION"]);
    });

    it("asks POCP for the whole NZ day when it's in daylight saving time", async () => {
      const requests = mockPocp([outage("ATI_0")]);

      await requestWorker("/v1/outages/2026-01-15");

      const params = new URL(requests[0].url).searchParams;
      expect(params.get("outageAtFrom")).toBe("2026-01-14T11:00:00.000Z");
      expect(params.get("outageAtTo")).toBe("2026-01-15T11:00:00.000Z");
    });

    it("maps outages to the units in service that day, at the node a unit moved from", async () => {
      // Pātea moved from Hawera (HWA1101) to Ōhangai (OHG1101) on 25 June 2026
      mockPocp([
        outage("PTA_1", {
          timeStart: "2026-03-10T08:00:00+13:00",
          timeEnd: "2026-03-10T17:00:00+13:00",
        }),
      ]);

      const { response } = await requestWorker("/v1/outages/2026-03-10");

      expect(Object.keys((await response.json()) as object)).toEqual(["HWA1101 PTA1"]);
    });

    it.each([
      {
        problem: "is within the last 14 days",
        date: "2026-11-20",
        outages: [
          outage("ATI_0", {
            timeStart: "2026-11-20T08:00:00+13:00",
            timeEnd: "2026-11-20T17:00:00+13:00",
          }),
        ],
        maxAge: "3600",
      },
      {
        problem: "is today",
        date: "2026-11-26",
        outages: [
          outage("ATI_0", {
            timeStart: "2026-11-26T08:00:00+13:00",
            timeEnd: "2026-11-26T17:00:00+13:00",
          }),
        ],
        maxAge: "3600",
      },
      { problem: "had no outages from POCP", date: "2026-06-10", outages: [], maxAge: "3600" },
    ])("caches a day for an hour when it $problem", async ({ date, outages, maxAge }) => {
      mockPocp(outages);

      const { response } = await requestWorker(`/v1/outages/${date}`);

      expect(response.headers.get("Cache-Control")).toBe(`max-age=${maxAge}`);
    });

    it("caches an older day for a week, as POCP has stopped revising its outages", async () => {
      mockPocp([
        outage("ATI_0", {
          timeStart: "2026-06-10T08:00:00+12:00",
          timeEnd: "2026-06-10T17:00:00+12:00",
        }),
      ]);

      const { response } = await requestWorker("/v1/outages/2026-06-10");

      expect(response.headers.get("Cache-Control")).toBe("max-age=604800");
    });

    it("answers later requests for the day from the edge cache without calling POCP again", async () => {
      const requests = mockPocp([
        outage("ATI_0", {
          timeStart: "2026-06-10T08:00:00+12:00",
          timeEnd: "2026-06-10T17:00:00+12:00",
        }),
      ]);
      await (await requestWorker("/v1/outages/2026-06-10")).finishBackgroundWork();

      const { response } = await requestWorker("/v1/outages/2026-06-10");

      expect(requests).toHaveLength(1);
      expect(await response.json()).toHaveProperty("ATI2201 ATI0");
    });

    it.each(["2026-6-10", "20260610", "2026-02-30", "2026-13-01", "latest"])(
      "rejects %s, which isn't a date",
      async (date) => {
        const requests = mockPocp([outage("ATI_0")]);

        const { response } = await requestWorker(`/v1/outages/${date}`);

        expect(response.status).toBe(400);
        expect(requests).toHaveLength(0);
      },
    );

    it.each([
      { problem: "returns an error", outages: [outage("ATI_0")], status: 500 },
      { problem: "returns no outage list", outages: null, status: 200 },
    ])("is unavailable, without being cached, when POCP $problem", async ({ outages, status }) => {
      mockPocp(outages, status);

      const { response } = await requestWorker("/v1/outages/2026-06-10");

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });
  });
});
