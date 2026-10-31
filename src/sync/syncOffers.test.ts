import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { syncOffers } from "./syncOffers";
import { downloadedDates, EMI_OFFERS_FOLDER, mockEmiOffers, offer } from "../testing/fixtures";
import { OfferRecord } from "../models/offerRecord";

describe("syncOffers", () => {
  it("stores the latest energy offers for each unit by trading period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T02:00:00Z"));
    const requests = mockEmiOffers([{
      date: "20261012",
      rows: [
        offer({ Tranche: "1", Megawatts: "40", DollarsPerMegawattHour: "0.01" }),
        offer({ Tranche: "2", Megawatts: "20", DollarsPerMegawattHour: "150" }),
        // superseded by a later offer
        offer({ IsLatestYesNo: "N", Tranche: "1", Megawatts: "35", DollarsPerMegawattHour: "5" }),
        // reserve offers
        offer({ ProductType: "Reserve", ProductClass: "Spinning", ReserveType: "FIR" }),
        // nothing offered
        offer({ PointOfConnection: "HLY2201", Unit: "HLY5", Megawatts: "0" }),
        // a wind farm can offer more than its forecast
        offer({ TradingPeriod: "2", PointOfConnection: "WWD1102", Unit: "WWD1", Megawatts: "100", ForecastOfGenerationPotentialMegawatts: "63.5", DollarsPerMegawattHour: "0" }),
      ],
    }], { otherBlobs: [{ name: `${EMI_OFFERS_FOLDER}README.txt` }] });

    await syncOffers();

    expect(downloadedDates(requests)).toEqual(["20261012"]);
    expect(await (await env.offers.get("offers-20261012"))!.json()).toEqual({
      "1": {
        "ATI2201 ATI0": [
          { tranche: 1, megawatts: 40, price: 0.01 },
          { tranche: 2, megawatts: 20, price: 150 },
        ],
      },
      "2": {
        "WWD1102 WWD1": [{ tranche: 1, megawatts: 100, price: 0 }],
      },
    });
    // only the wind farm gives a forecast
    expect(await (await env.offers.get("fogp-20261012"))!.json()).toEqual({
      "2": { "WWD1102 WWD1": 63.5 },
    });
    // records when it last got new data, for the stale data check
    expect(await env.dispatch_kv.getWithMetadata("latestSyncedOffers")).toEqual({
      value: "20261012",
      metadata: { updatedAt: Date.now() },
    });
  });

  it("stores what an intermittent unit offers in each tranche, rather than its forecast", async () => {
    // Turitea's offer for 2026-10-24, where EMI repeats its 178.8 MW forecast on every tranche
    const turitea = (overrides: Partial<OfferRecord>) => offer({
      TradingPeriod: "18", PointOfConnection: "LTN2201", Unit: "TUR0", SubmissionOrder: "68",
      MaximumOutputMegawatts: "222.000", ForecastOfGenerationPotentialMegawatts: "178.800", ...overrides,
    });
    mockEmiOffers([{
      date: "20261024",
      rows: [
        turitea({ Tranche: "2", Megawatts: "141.400", DollarsPerMegawattHour: "0.02" }),
        turitea({ Tranche: "4", Megawatts: "0.000", DollarsPerMegawattHour: "0.05" }),
        turitea({ Tranche: "5", Megawatts: "0.000", DollarsPerMegawattHour: "0.06" }),
        turitea({ Tranche: "1", Megawatts: "80.000", DollarsPerMegawattHour: "0.01" }),
        turitea({ Tranche: "3", Megawatts: "0.000", DollarsPerMegawattHour: "0.04" }),
        // offering less than the forecast
        turitea({ TradingPeriod: "19", Megawatts: "40.000", DollarsPerMegawattHour: "0.01" }),
      ],
    }]);

    await syncOffers();

    expect(await (await env.offers.get("offers-20261024"))!.json()).toEqual({
      "18": {
        "LTN2201 TUR0": [
          { tranche: 2, megawatts: 141.4, price: 0.02 },
          { tranche: 1, megawatts: 80, price: 0.01 },
        ],
      },
      "19": {
        "LTN2201 TUR0": [{ tranche: 1, megawatts: 40, price: 0.01 }],
      },
    });
    expect(await (await env.offers.get("fogp-20261024"))!.json()).toEqual({
      "18": { "LTN2201 TUR0": 178.8 },
      "19": { "LTN2201 TUR0": 178.8 },
    });
  });

  it("stores a unit's forecast of generation potential even when nothing is offered", async () => {
    mockEmiOffers([{
      date: "20261024",
      rows: [
        offer({ TradingPeriod: "3", PointOfConnection: "LTN2201", Unit: "TUR0", Tranche: "1", Megawatts: "0.000", ForecastOfGenerationPotentialMegawatts: "4.200" }),
        offer({ TradingPeriod: "3", PointOfConnection: "LTN2201", Unit: "TUR0", Tranche: "2", Megawatts: "0.000", ForecastOfGenerationPotentialMegawatts: "4.200" }),
        // no wind at all
        offer({ TradingPeriod: "4", PointOfConnection: "LTN2201", Unit: "TUR0", Megawatts: "0.000", ForecastOfGenerationPotentialMegawatts: "0.000" }),
        // a superseded forecast
        offer({ TradingPeriod: "4", PointOfConnection: "WWD1102", Unit: "WWD1", IsLatestYesNo: "N", ForecastOfGenerationPotentialMegawatts: "50" }),
        // forecasts on reserve offers aren't kept
        offer({ TradingPeriod: "4", PointOfConnection: "WWD1102", Unit: "WWD1", ProductType: "Reserve", ProductClass: "Spinning", ReserveType: "FIR", ForecastOfGenerationPotentialMegawatts: "50" }),
      ],
    }]);

    await syncOffers();

    expect(await (await env.offers.get("offers-20261024"))!.json()).toEqual({});
    expect(await (await env.offers.get("fogp-20261024"))!.json()).toEqual({
      "3": { "LTN2201 TUR0": 4.2 },
      "4": { "LTN2201 TUR0": 0 },
    });
  });

  it("keeps a unit's forecast from its latest submission, when its tranches' latest offers are from different ones", async () => {
    // West Wind's offers for 2019-10-24. tranche 1 was offered again the day before, but the latest offers for the
    // other tranches are still the ones from a week before, with the forecast from then
    const westWind = (overrides: Partial<OfferRecord>) => offer({
      TradingDate: "2019-10-24", ParticipantCode: "MERI", PointOfConnection: "WWD1102", Unit: "WWD0",
      MaximumOutputMegawatts: "69.000", Megawatts: "0.000", DollarsPerMegawattHour: "0.00", ...overrides,
    });
    const lastWeek = { UTCSubmissionDate: "2019-10-17", SubmissionOrder: "1", ForecastOfGenerationPotentialMegawatts: "14.226" };
    mockEmiOffers([{
      date: "20191024",
      rows: [
        westWind({ Tranche: "1", UTCSubmissionDate: "2019-10-23", SubmissionOrder: "33", ForecastOfGenerationPotentialMegawatts: "8.000", Megawatts: "69.000", DollarsPerMegawattHour: "0.01" }),
        westWind({ Tranche: "2", ...lastWeek }),
        westWind({ Tranche: "3", ...lastWeek }),
        // the latest submission can come after the older ones in the file
        westWind({ TradingPeriod: "2", Tranche: "2", ...lastWeek }),
        westWind({ TradingPeriod: "2", Tranche: "1", UTCSubmissionDate: "2019-10-23", SubmissionOrder: "34", ForecastOfGenerationPotentialMegawatts: "9.500" }),
      ],
    }]);

    await syncOffers();

    expect(await (await env.offers.get("fogp-20191024"))!.json()).toEqual({
      "1": { "WWD1102 WWD0": 8 },
      "2": { "WWD1102 WWD0": 9.5 },
    });
  });

  it("only downloads files after the last synced date", async () => {
    await env.dispatch_kv.put("latestSyncedOffers", "20261011");
    const requests = mockEmiOffers([{ date: "20261010" }, { date: "20261011" }, { date: "20261012" }]);

    await syncOffers();

    expect(downloadedDates(requests)).toEqual(["20261012"]);
    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBe("20261012");
  });

  it("stops starting new downloads once the time budget is used up, and carries on in the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dates = ["20261008", "20261009", "20261010", "20261011", "20261012"];
    let isFirstDownload = true;
    const requests = mockEmiOffers(dates.map(date => ({ date })), {
      onDownload: () => {
        // the first download takes longer than the whole time budget
        if (isFirstDownload) {
          isFirstDownload = false;
          vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        }
      },
    });

    await syncOffers();

    expect(downloadedDates(requests)).toEqual(["20261008", "20261009", "20261010"]);
    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBe("20261010");

    await syncOffers();

    expect(downloadedDates(requests)).toEqual(dates);
    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBe("20261012");
  });

  it("doesn't move the checkpoint past a file that failed to download", async () => {
    mockEmiOffers([{ date: "20261011" }, { date: "20261012", status: 503 }]);

    await expect(syncOffers()).rejects.toThrow("Failed to download");

    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBeNull();
  });
});
