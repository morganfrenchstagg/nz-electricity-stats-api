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
