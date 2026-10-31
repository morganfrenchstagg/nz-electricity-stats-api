import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { backfillFogp } from "./backfillFogp";
import { downloadedDates, mockEmiOffers, offer } from "../testing/fixtures";

const CHECKPOINT_KEY = "latestBackfilledFogp";

// some of EMI's offers for 2019-10-24, the first day with forecasts. files from then quote their empty fields, and West
// Wind's tranche 2 is still from a week before, with the forecast from then
const OFFERS_20191024 = [
  `2019-10-24,1,MERI,WWD1102,WWD0,Energy,Injection,"",Energy injected at a point of connection,2019-10-23,10:51:14.000,33,Y,1,9999.000,9999.000,"",69.000,8.000,69.000,0.01`,
  `2019-10-24,1,MERI,WWD1102,WWD0,Energy,Injection,"",Energy injected at a point of connection,2019-10-17,11:01:12.000,1,Y,2,9999.000,9999.000,"",69.000,14.226,0.000,0.00`,
  `2019-10-24,1,MRPL,ATI2201,ATI0,Energy,Injection,"",Energy injected at a point of connection,2019-10-23,08:10:46.000,2,Y,1,4000.000,4000.000,"",55.000,"",19.000,0.49`,
];

// what the offers sync stored for each day
const STORED_OFFERS = { "1": { "ATI2201 ATI0": [{ tranche: 1, megawatts: 40, price: 0.01 }] } };
const STORED_FOGP = { "1": { "WWD1102 WWD0": 1 } };

async function storeOffers(date: string, { withFogp = false } = {}) {
  await env.offers.put("offers-" + date, JSON.stringify(STORED_OFFERS));
  if (withFogp) {
    await env.offers.put("fogp-" + date, JSON.stringify(STORED_FOGP));
  }
}

// West Wind's offer in trading period 1, with its forecast
const forecast = (megawatts: number) =>
  offer({ PointOfConnection: "WWD1102", Unit: "WWD0", ForecastOfGenerationPotentialMegawatts: String(megawatts) });

async function getJson(key: string) {
  return await (await env.offers.get(key))?.json();
}

// the count days (YYYYMMDD) from first
function daysFrom(first: string, count: number): string[] {
  const start = Date.UTC(+first.slice(0, 4), +first.slice(4, 6) - 1, +first.slice(6, 8));
  return Array.from({ length: count }, (_, i) => new Date(start + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, ""));
}

describe("backfillFogp", () => {
  it("saves the forecasts for the days with offers but no fogp file, without changing their offers", async () => {
    await env.dispatch_kv.put("latestSyncedOffers", "20261026");
    await storeOffers("20191024");
    await storeOffers("20191025");
    // synced since the offers sync kept forecasts
    await storeOffers("20261026", { withFogp: true });
    const requests = mockEmiOffers([
      { date: "20191024", rows: OFFERS_20191024 },
      { date: "20191025", rows: [forecast(12.5)] },
      { date: "20261026", rows: [forecast(50)] },
    ]);

    await backfillFogp();

    expect(downloadedDates(requests)).toEqual(["20191024", "20191025"]);
    // from West Wind's latest submission, and only units that give a forecast
    expect(await getJson("fogp-20191024")).toEqual({ "1": { "WWD1102 WWD0": 8 } });
    expect(await getJson("fogp-20191025")).toEqual({ "1": { "WWD1102 WWD0": 12.5 } });
    expect(await getJson("fogp-20261026")).toEqual(STORED_FOGP);
    expect(await getJson("offers-20191024")).toEqual(STORED_OFFERS);
    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBe("20261026");
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20261026");
  });

  it("doesn't backfill the days before EMI's offers had forecasts", async () => {
    await storeOffers("20191022");
    await storeOffers("20191023");
    await storeOffers("20191024");
    const requests = mockEmiOffers([{ date: "20191022" }, { date: "20191023" }, { date: "20191024", rows: [forecast(8)] }]);

    await backfillFogp();

    expect(downloadedDates(requests)).toEqual(["20191024"]);
    expect(await env.offers.get("fogp-20191023")).toBeNull();
  });

  it("only checks the days synced since its last run, so it doesn't download anything once it's caught up", async () => {
    await env.dispatch_kv.put(CHECKPOINT_KEY, "20261026");
    await storeOffers("20261026", { withFogp: true });
    await storeOffers("20261027", { withFogp: true });
    const requests = mockEmiOffers([]);

    await backfillFogp();

    expect(requests).toEqual([]);
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20261027");

    await backfillFogp();

    expect(requests).toEqual([]);
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20261027");
  });

  it("finds the days missing a fogp file among more than a page of files", async () => {
    const days = daysFrom("20191024", 1100);
    for (const date of days.slice(0, -1)) {
      await storeOffers(date, { withFogp: true });
    }
    await storeOffers(days[days.length - 1]);
    const requests = mockEmiOffers([{ date: days[days.length - 1], rows: [forecast(5)] }]);

    await backfillFogp();

    expect(downloadedDates(requests)).toEqual([days[days.length - 1]]);
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe(days[days.length - 1]);
  });

  it("moves on from the days EMI no longer has the offers for", async () => {
    await storeOffers("20191024");
    await storeOffers("20191025");
    const requests = mockEmiOffers([{ date: "20191025", rows: [forecast(8)] }]);

    await backfillFogp();

    expect(downloadedDates(requests)).toEqual(["20191025"]);
    expect(await env.offers.get("fogp-20191024")).toBeNull();
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20191025");
  });

  it("stops starting new downloads once the time budget is used up, and carries on in the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const days = ["20191024", "20191025", "20191026", "20191027", "20191028"];
    for (const date of days) {
      await storeOffers(date);
    }
    let isFirstDownload = true;
    const requests = mockEmiOffers(days.map(date => ({ date, rows: [forecast(8)] })), {
      onDownload: () => {
        // the first download takes longer than the whole time budget
        if (isFirstDownload) {
          isFirstDownload = false;
          vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        }
      },
    });

    await backfillFogp();

    expect(downloadedDates(requests)).toEqual(["20191024", "20191025", "20191026"]);
    expect(await env.offers.get("fogp-20191027")).toBeNull();
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20191026");

    await backfillFogp();

    expect(downloadedDates(requests)).toEqual(days);
    expect(await getJson("fogp-20191028")).toEqual({ "1": { "WWD1102 WWD0": 8 } });
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20191028");
  });

  it("doesn't move the checkpoint past a file that failed to download, and backfills it in the next run", async () => {
    await storeOffers("20191024");
    await storeOffers("20191025");
    mockEmiOffers([{ date: "20191024", status: 503 }, { date: "20191025", rows: [forecast(8)] }]);

    await expect(backfillFogp()).rejects.toThrow("Failed to download");

    expect(await env.offers.get("fogp-20191024")).toBeNull();
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBeNull();

    mockEmiOffers([{ date: "20191024", rows: [forecast(7)] }, { date: "20191025", rows: [forecast(8)] }]);

    await backfillFogp();

    expect(await getJson("fogp-20191024")).toEqual({ "1": { "WWD1102 WWD0": 7 } });
    expect(await env.dispatch_kv.get(CHECKPOINT_KEY)).toBe("20191025");
  });
});
