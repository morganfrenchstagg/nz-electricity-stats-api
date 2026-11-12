import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { syncDailyDispatch } from "./syncDailyDispatch";
import { mockFetch, streamedResponse } from "../testing/fetchMock";
import { downloadedDates, EMI_DATASETS_FILES_URL, EMI_DATASETS_LISTING_URL, emiBlobListing, ListedBlob } from "../testing/fixtures";

const FOLDER = "Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/";
const HEADER = "TradingDate,TradingPeriod,IntervalDateTime,PointOfConnectionCode,UnitCode,DollarsPerMegawattHour,LoadMegawatts,InitialMegawatts,GenerationMegawatts";

type DailyFile = {
  date: string; // YYYYMMDD
  rows?: string[];
  lastModified?: string;
  status?: number;
};

const blobName = (date: string) => `${FOLDER}${date.slice(0, 4)}/${date}_DispatchNodalPricesAndVolumes.csv`;

// interval is e.g. 2026-10-12T00:05. initial is the MW at the start of the interval, generation what it was dispatched to
const row = (interval: string, pointOfConnection: string, unit: string, price: number, load: number, initial: number, generation = initial) =>
  `${interval.slice(0, 10)},1,${interval}:00.000+13:00,${pointOfConnection},${unit},${price},${load},${initial},${generation}`;

function mockEmi(files: DailyFile[], { otherBlobs = [] as ListedBlob[], onDownload = () => { } } = {}) {
  return mockFetch({
    [EMI_DATASETS_LISTING_URL]: (request) => emiBlobListing([
      ...files.map(file => ({ name: blobName(file.date), lastModified: file.lastModified })),
      ...otherBlobs,
    ].filter(blob => blob.name.startsWith(new URL(request.url).searchParams.get("prefix")!))),
    [EMI_DATASETS_FILES_URL]: (request) => {
      onDownload();
      const file = files.find(file => request.url === EMI_DATASETS_FILES_URL + blobName(file.date))!;
      if (file.status) {
        return new Response("", { status: file.status });
      }
      const rows = file.rows ?? [row(`${file.date.slice(0, 4)}-${file.date.slice(4, 6)}-${file.date.slice(6)}T00:00`, "ATI2201", "ATI0", 100, 0, 50)];
      return streamedResponse([HEADER, ...rows].join("\r\n") + "\r\n");
    },
  });
}

// the folders listed, e.g. 2026/ for .../NodalPricesAndVolumes/2026/
const listedFolders = (requests: Request[]) => requests
  .filter(request => request.url.startsWith(EMI_DATASETS_LISTING_URL))
  .map(request => new URL(request.url).searchParams.get("prefix")!.slice(FOLDER.length));

async function getJson(key: string) {
  return await (await env.dispatch.get(key))?.json();
}

describe("syncDailyDispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T02:00:00Z"));
  });

  it("stores each daily file as dispatch records grouped by interval", async () => {
    const requests = mockEmi([
      { date: "20261011" },
      {
        date: "20261012",
        rows: [
          row("2026-10-12T00:00", "ATI2201", "ATI0", 120.5, 0, 50),
          row("2026-10-12T00:00", "ALB0331", "N/A", 130, 20, 0),
          row("2026-10-12T00:05", "ATI2201", "ATI0", 118, 0, 52),
        ],
      },
    ], { otherBlobs: [{ name: `${FOLDER}README.txt` }] });

    await syncDailyDispatch();

    expect(downloadedDates(requests)).toEqual(["20261011", "20261012"]);
    expect(await getJson("dispatch-20261012")).toEqual({
      "2026-10-12T00:00:00": [
        { p: "ATI2201 ATI0", l: 0, g: 50, c: 120.5, m: true },
        { p: "ALB0331", l: 20, g: 0, c: 130 },
      ],
      "2026-10-12T00:05:00": [
        { p: "ATI2201 ATI0", l: 0, g: 52, c: 118, m: true },
      ],
    });
    expect(await env.dispatch.get("dispatch-20261011")).not.toBeNull();
    // records when it last got new data, for the stale data check
    expect(await env.dispatch_kv.getWithMetadata("latestDailySyncDate")).toEqual({
      value: "20261012",
      metadata: { updatedAt: Date.now() },
    });
  });

  it("uses each unit's initial MW as its generation, noting whether it matches what it was dispatched to", async () => {
    mockEmi([{
      date: "20261012",
      rows: [
        row("2026-10-12T00:00", "ATI2201", "ATI0", 100, 0, 15.829, 0),
        row("2026-10-12T00:00", "BEN2202", "BEN0", 100, 0, 67.4, 240.389),
        // matching values can be written to different decimal places
        "2026-10-12,1,2026-10-12T00:00:00.000+13:00,BPE0331,TWF0,100,0,14.12,14.120",
        row("2026-10-12T00:00", "MHO0331", "MHO0", 100, 0, -0.3, 0),
        // a battery charging is load, with no initial or dispatched generation
        row("2026-10-12T00:00", "HLY0331", "RHO99", 100, 1.6, 0, 0),
        // a load node's initial MW is its load, not generation
        row("2026-10-12T00:00", "ALB0331", "N/A", 100, 60.933, 62.1, 0),
      ],
    }]);

    await syncDailyDispatch();

    expect(await getJson("dispatch-20261012")).toEqual({
      "2026-10-12T00:00:00": [
        { p: "ATI2201 ATI0", l: 0, g: 15.829, c: 100, m: false },
        { p: "BEN2202 BEN0", l: 0, g: 67.4, c: 100, m: false },
        { p: "BPE0331 TWF0", l: 0, g: 14.12, c: 100, m: true },
        { p: "MHO0331 MHO0", l: 0, g: -0.3, c: 100, m: false },
        { p: "HLY0331 RHO99", l: 1.6, g: 0, c: 100, m: true },
        { p: "ALB0331", l: 60.933, g: 0, c: 100 },
      ],
    });
  });

  it("only downloads files published since the last sync", async () => {
    await env.dispatch.put("dispatch-20261011", "{}");
    await env.dispatch_kv.put("latestDailySyncDate", "20261011");
    const requests = mockEmi([
      { date: "20261011", lastModified: "Mon, 12 Oct 2026 01:00:00 GMT" },
      { date: "20261012", lastModified: "Tue, 13 Oct 2026 01:00:00 GMT" },
    ]);

    await syncDailyDispatch();

    expect(downloadedDates(requests)).toEqual(["20261012"]);
    expect(await env.dispatch_kv.get("latestDailySyncDate")).toBe("20261012");
  });

  it("does nothing when there are no new files", async () => {
    await env.dispatch.put("dispatch-20261012", "{}");
    await env.dispatch_kv.put("latestDailySyncDate", "20261012");
    const requests = mockEmi([{ date: "20261012", lastModified: "Tue, 13 Oct 2026 01:00:00 GMT" }]);

    await syncDailyDispatch();

    expect(downloadedDates(requests)).toEqual([]);
    expect(await getJson("dispatch-20261012")).toEqual({});
  });

  it("re-downloads files EMI has republished, queueing them for re-aggregation without moving the checkpoint backwards", async () => {
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    await env.dispatch.put("dispatch-20261011", "{}");
    await env.dispatch.put("dispatch-20261012", "{}");
    await env.dispatch_kv.put("latestDailySyncDate", "20261012");
    await env.dispatch_kv.put("latestAggregatedDispatchDate", "2026-10-12");
    vi.setSystemTime(new Date("2026-10-14T02:00:00Z"));

    const requests = mockEmi([
      { date: "20261011", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
      { date: "20261012", lastModified: "Mon, 12 Oct 2026 01:00:00 GMT" },
    ]);

    await syncDailyDispatch();

    expect(downloadedDates(requests)).toEqual(["20261011"]);
    expect(await getJson("dispatch-20261011")).toHaveProperty("2026-10-11T00:00:00");
    expect(await env.dispatch_kv.get("latestDailySyncDate")).toBe("20261012");
    expect(await env.dispatch_kv.get("dispatchDatesToReaggregate")).toBe(JSON.stringify(["2026-10-11"]));
  });

  describe("checking for republished files", () => {
    // stored before EMI republished them on 14 October
    async function storeFiles(dates: string[]) {
      vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
      for (const date of dates) {
        await env.dispatch.put("dispatch-" + date, "{}");
      }
      await env.dispatch_kv.put("latestDailySyncDate", dates.at(-1)!);
    }

    it("only checks the last two weeks' files each hour, from the current year's folder", async () => {
      await storeFiles(["20260901", "20260929", "20261011"]);
      vi.setSystemTime(new Date("2026-10-14T02:00:00Z"));
      const list = vi.spyOn(env.dispatch, "list");
      const requests = mockEmi([
        { date: "20250901", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
        { date: "20260901", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
        { date: "20260929", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
        { date: "20260930", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
        { date: "20261011", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
      ]);

      await syncDailyDispatch();

      expect(listedFolders(requests)).toEqual(["2026/"]);
      expect(list.mock.calls.map(([options]) => options?.startAfter)).toEqual(["dispatch-20260929"]);
      // 30 September is missing, so it's downloaded again too
      expect(downloadedDates(requests)).toEqual(["20260930", "20261011"]);
    });

    it("checks every file once a day", async () => {
      await storeFiles(["20260901", "20261011"]);
      vi.setSystemTime(new Date("2026-10-14T12:02:00Z"));
      const requests = mockEmi([
        { date: "20260901", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
        { date: "20261011", lastModified: "Wed, 14 Oct 2026 01:00:00 GMT" },
      ]);

      await syncDailyDispatch();

      expect(listedFolders(requests)).toEqual([""]);
      expect(downloadedDates(requests)).toEqual(["20260901", "20261011"]);
    });

    it("lists the previous year's folder too while the last two weeks span the new year", async () => {
      await env.dispatch_kv.put("latestDailySyncDate", "20270103");
      vi.setSystemTime(new Date("2027-01-05T02:00:00Z"));
      const requests = mockEmi([{ date: "20261225" }, { date: "20270104" }]);

      await syncDailyDispatch();

      expect(listedFolders(requests)).toEqual(["2026/", "2027/"]);
      expect(downloadedDates(requests)).toEqual(["20261225", "20270104"]);
    });

    it("lists every year since the last sync when it's further behind", async () => {
      await env.dispatch_kv.put("latestDailySyncDate", "20250601");
      const requests = mockEmi([{ date: "20250601" }, { date: "20250602" }, { date: "20261012" }]);

      await syncDailyDispatch();

      expect(listedFolders(requests)).toEqual(["2025/", "2026/"]);
      expect(downloadedDates(requests)).toEqual(["20250602", "20261012"]);
    });
  });

  it("follows the listing across pages", async () => {
    const requests = mockFetch({
      [EMI_DATASETS_LISTING_URL]: (request) => new URL(request.url).searchParams.get("marker") === "page-2"
        ? emiBlobListing([{ name: blobName("20261012") }])
        : emiBlobListing([{ name: blobName("20261011") }], "page-2"),
      [EMI_DATASETS_FILES_URL]: () => streamedResponse(`${HEADER}\r\n${row("2026-10-11T00:00", "ATI2201", "ATI0", 100, 0, 50)}`),
    });

    await syncDailyDispatch();

    const listings = requests.filter(request => request.url.startsWith(EMI_DATASETS_LISTING_URL));
    expect(listings.map(request => new URL(request.url).searchParams.get("prefix"))).toEqual([FOLDER, FOLDER]);
    expect(downloadedDates(requests)).toEqual(["20261011", "20261012"]);
  });

  it("stops starting new downloads once the time budget is used up, and carries on in the next run", async () => {
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

    await syncDailyDispatch();

    // the rest of the batch of 3 is finished before stopping
    expect(downloadedDates(requests)).toEqual(["20261008", "20261009", "20261010"]);
    expect(await env.dispatch.get("dispatch-20261011")).toBeNull();
    expect(await env.dispatch_kv.get("latestDailySyncDate")).toBe("20261010");

    await syncDailyDispatch();

    expect(downloadedDates(requests)).toEqual(dates);
    expect(await env.dispatch_kv.get("latestDailySyncDate")).toBe("20261012");
  });

  it("doesn't move the checkpoint past a file that failed to download", async () => {
    mockEmi([{ date: "20261011" }, { date: "20261012", status: 500 }]);

    await expect(syncDailyDispatch()).rejects.toThrow("Failed to download");

    expect(await env.dispatch_kv.get("latestDailySyncDate")).toBeNull();
  });
});
