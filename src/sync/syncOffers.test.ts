import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { syncOffers } from "./syncOffers";
import { mockFetch, streamedResponse } from "../testing/fetchMock";
import { downloadedDates, EMI_DATASETS_FILES_URL, EMI_DATASETS_LISTING_URL, emiBlobListing, ListedBlob } from "../testing/fixtures";
import { OfferRecord } from "../models/offerRecord";

const FOLDER = "Datasets/Wholesale/BidsAndOffers/Offers/";

const defaultOffer: OfferRecord = {
  TradingDate: "2026-10-12",
  TradingPeriod: "1",
  ParticipantCode: "MRPL",
  PointOfConnection: "ATI2201",
  Unit: "ATI0",
  ProductType: "Energy",
  ProductClass: "Injection",
  ReserveType: "",
  ProductDescription: "",
  UTCSubmissionDate: "2026-10-11",
  UTCSubmissionTime: "10:00:00",
  SubmissionOrder: "1",
  IsLatestYesNo: "Y",
  Tranche: "1",
  MaximumRampUpMegawattsPerHour: "",
  MaximumRampDownMegawattsPerHour: "",
  PartiallyLoadedSpinningReservePercent: "",
  MaximumOutputMegawatts: "",
  ForecastOfGenerationPotentialMegawatts: "",
  Megawatts: "40",
  DollarsPerMegawattHour: "0.01",
};

const offer = (overrides: Partial<OfferRecord>) => Object.values({ ...defaultOffer, ...overrides }).join(",");

type OffersFile = {
  date: string; // YYYYMMDD
  rows?: string[];
  status?: number;
};

const blobName = (date: string) => `${FOLDER}${date.slice(0, 4)}/${date}_Offers.csv`;

function mockEmi(files: OffersFile[], { otherBlobs = [] as ListedBlob[], onDownload = () => { } } = {}) {
  return mockFetch({
    [EMI_DATASETS_LISTING_URL]: () => emiBlobListing([...files.map(file => ({ name: blobName(file.date) })), ...otherBlobs]),
    [EMI_DATASETS_FILES_URL]: (request) => {
      onDownload();
      const file = files.find(file => request.url === EMI_DATASETS_FILES_URL + blobName(file.date))!;
      if (file.status) {
        return new Response("", { status: file.status });
      }
      const rows = file.rows ?? [offer({})];
      return streamedResponse([Object.keys(defaultOffer).join(","), ...rows].join("\r\n") + "\r\n");
    },
  });
}

describe("syncOffers", () => {
  it("stores the latest energy offers for each unit by trading period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T02:00:00Z"));
    const requests = mockEmi([{
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
        // wind farms offer their forecast output
        offer({ TradingPeriod: "2", PointOfConnection: "WWD1102", Unit: "WWD1", Megawatts: "100", ForecastOfGenerationPotentialMegawatts: "63.5", DollarsPerMegawattHour: "0" }),
      ],
    }], { otherBlobs: [{ name: `${FOLDER}README.txt` }] });

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
        "WWD1102 WWD1": [{ tranche: 1, megawatts: 63.5, price: 0 }],
      },
    });
    // records when it last got new data, for the stale data check
    expect(await env.dispatch_kv.getWithMetadata("latestSyncedOffers")).toEqual({
      value: "20261012",
      metadata: { updatedAt: Date.now() },
    });
  });

  it("caps an intermittent unit's tranches at its forecast, cheapest first", async () => {
    // Turitea's offer for 2026-10-24, where EMI repeats its 178.8 MW forecast on every tranche
    const turitea = (overrides: Partial<OfferRecord>) => offer({
      TradingPeriod: "18", PointOfConnection: "LTN2201", Unit: "TUR0", SubmissionOrder: "68",
      MaximumOutputMegawatts: "222.000", ForecastOfGenerationPotentialMegawatts: "178.800", ...overrides,
    });
    const kaiweraDowns = (overrides: Partial<OfferRecord>) => offer({
      TradingPeriod: "18", PointOfConnection: "KIW2201", Unit: "KWE0", SubmissionOrder: "67",
      MaximumOutputMegawatts: "155.000", ForecastOfGenerationPotentialMegawatts: "130.900", ...overrides,
    });
    mockEmi([{
      date: "20261024",
      // a unit's tranches are spread through the file, between other units' offers
      rows: [
        turitea({ Tranche: "2", Megawatts: "141.400", DollarsPerMegawattHour: "0.02" }),
        kaiweraDowns({ Tranche: "2", Megawatts: "138.800", DollarsPerMegawattHour: "2.66" }),
        turitea({ Tranche: "4", Megawatts: "0.000", DollarsPerMegawattHour: "0.05" }),
        offer({ TradingPeriod: "18", Tranche: "1", Megawatts: "40", DollarsPerMegawattHour: "0.01" }),
        turitea({ Tranche: "5", Megawatts: "0.000", DollarsPerMegawattHour: "0.06" }),
        kaiweraDowns({ Tranche: "1", Megawatts: "16.000", DollarsPerMegawattHour: "0.01" }),
        turitea({ Tranche: "1", Megawatts: "80.000", DollarsPerMegawattHour: "0.01" }),
        offer({ TradingPeriod: "18", Tranche: "2", Megawatts: "20", DollarsPerMegawattHour: "150" }),
        turitea({ Tranche: "3", Megawatts: "0.000", DollarsPerMegawattHour: "0.04" }),
        // a dearer tranche past the forecast is cut back to nothing
        turitea({ TradingPeriod: "19", Tranche: "1", Megawatts: "80.000", ForecastOfGenerationPotentialMegawatts: "60.000", DollarsPerMegawattHour: "0.01" }),
        turitea({ TradingPeriod: "19", Tranche: "2", Megawatts: "141.400", ForecastOfGenerationPotentialMegawatts: "60.000", DollarsPerMegawattHour: "0.02" }),
        // the cheapest tranche is filled first, whatever its number
        turitea({ TradingPeriod: "20", Tranche: "1", Megawatts: "80.000", DollarsPerMegawattHour: "10" }),
        turitea({ TradingPeriod: "20", Tranche: "2", Megawatts: "141.400", DollarsPerMegawattHour: "0.01" }),
      ],
    }]);

    await syncOffers();

    expect(await (await env.offers.get("offers-20261024"))!.json()).toEqual({
      "18": {
        "LTN2201 TUR0": [
          { tranche: 2, megawatts: 98.8, price: 0.02 },
          { tranche: 1, megawatts: 80, price: 0.01 },
        ],
        "KIW2201 KWE0": [
          { tranche: 2, megawatts: 114.9, price: 2.66 },
          { tranche: 1, megawatts: 16, price: 0.01 },
        ],
        // units without a forecast keep all they offer
        "ATI2201 ATI0": [
          { tranche: 1, megawatts: 40, price: 0.01 },
          { tranche: 2, megawatts: 20, price: 150 },
        ],
      },
      "19": {
        "LTN2201 TUR0": [
          { tranche: 1, megawatts: 60, price: 0.01 },
          { tranche: 2, megawatts: 0, price: 0.02 },
        ],
      },
      "20": {
        "LTN2201 TUR0": [
          { tranche: 1, megawatts: 37.4, price: 10 },
          { tranche: 2, megawatts: 141.4, price: 0.01 },
        ],
      },
    });
  });

  it("caps a single tranche at the forecast only when it's more than the forecast", async () => {
    const westWind = (overrides: Partial<OfferRecord>) => offer({
      PointOfConnection: "WWD1102", Unit: "WWD1", MaximumOutputMegawatts: "143.000", DollarsPerMegawattHour: "0", ...overrides,
    });
    mockEmi([{
      date: "20261012",
      rows: [
        westWind({ TradingPeriod: "1", Megawatts: "40", ForecastOfGenerationPotentialMegawatts: "63.5" }),
        westWind({ TradingPeriod: "2", Megawatts: "100", ForecastOfGenerationPotentialMegawatts: "63.5" }),
        westWind({ TradingPeriod: "3", Megawatts: "100", ForecastOfGenerationPotentialMegawatts: "0.000" }),
      ],
    }]);

    await syncOffers();

    expect(await (await env.offers.get("offers-20261012"))!.json()).toEqual({
      "1": { "WWD1102 WWD1": [{ tranche: 1, megawatts: 40, price: 0 }] },
      "2": { "WWD1102 WWD1": [{ tranche: 1, megawatts: 63.5, price: 0 }] },
      "3": { "WWD1102 WWD1": [{ tranche: 1, megawatts: 0, price: 0 }] },
    });
  });

  it("only downloads files after the last synced date", async () => {
    await env.dispatch_kv.put("latestSyncedOffers", "20261011");
    const requests = mockEmi([{ date: "20261010" }, { date: "20261011" }, { date: "20261012" }]);

    await syncOffers();

    expect(downloadedDates(requests)).toEqual(["20261012"]);
    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBe("20261012");
  });

  it("stops starting new downloads once the time budget is used up, and carries on in the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dates = ["20261008", "20261009", "20261010", "20261011", "20261012"];
    let isFirstDownload = true;
    const requests = mockEmi(dates.map(date => ({ date })), {
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
    mockEmi([{ date: "20261011" }, { date: "20261012", status: 503 }]);

    await expect(syncOffers()).rejects.toThrow("Failed to download");

    expect(await env.dispatch_kv.get("latestSyncedOffers")).toBeNull();
  });
});
