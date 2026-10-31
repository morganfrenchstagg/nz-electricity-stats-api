import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { syncHvdcHistory } from "./syncHvdcHistory";
import { mockFetch } from "../testing/fetchMock";
import { downloadedDates, EMI_DATASETS_FILES_URL, EMI_DATASETS_LISTING_URL, emiBlobListing, HVDC_TIMESERIES } from "../testing/fixtures";

const FOLDER = "Datasets/Wholesale/Metered_data/HVDC_Flows/";
const HEADER = "POC,Nwk_Code,Generation_Type,Trader,Unit_Measure,Flow_Direction,Status,Trading_Date,"
  + Array.from({ length: 50 }, (_, i) => `TP${i + 1}`).join(",");
const SERIES = HVDC_TIMESERIES.series;

type MonthlyFile = {
  month: string; // YYYYMM
  days?: string[]; // trading dates, defaults to the 1st and 2nd of the month
  north?: number; // MW sent north all day, defaults to 500
  lastModified?: string;
};

const fileName = (file: MonthlyFile) => `${FOLDER}${file.month}_HVDC_flows.csv`;
const firstDays = (month: string) => [`${month.slice(0, 4)}-${month.slice(4)}-01`, `${month.slice(0, 4)}-${month.slice(4)}-02`];

// a meter at a constant MW all day, so it sends mw x 24 MWh
const row = (poc: string, date: string, mw: number) => `${poc},TPNZ,DC,TPNZ,kWh,X,F,${date},${Array(48).fill(mw * 500).join(",")},,`;

function mockEmi(files: MonthlyFile[], onDownload = () => { }) {
  return mockFetch({
    [EMI_DATASETS_LISTING_URL]: () => emiBlobListing(files.map(file => ({ name: fileName(file), lastModified: file.lastModified }))),
    [EMI_DATASETS_FILES_URL]: (request) => {
      onDownload();
      const file = files.find(file => request.url === `${EMI_DATASETS_FILES_URL}${fileName(file)}`)!;
      const rows = (file.days ?? firstDays(file.month)).flatMap(date => [row("BEN2201", date, file.north ?? 500), row("HAY2201", date, 10)]);
      return new Response([HEADER, ...rows].join("\r\n") + "\r\n");
    },
  });
}

// the MWh sent north and south, as stored in the HVDC aggregates
const dataPoint = (from: string, to: string, north: number, south: number) =>
  ({ from, to, nodes: { northFlow: { g: north, l: 0 }, southFlow: { g: south, l: 0 } } });
const day = (date: string, north: number, south: number) => dataPoint(date, date, north, south);

async function getJson(key: string) {
  return await (await env.dispatch.get(key))?.json();
}

// em6's half hours on a day, each with the given north flow
async function storeEm6Day(date: string, north: number[]) {
  const data = north.map((mw, index) => [`${date}T${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00`, mw, 0, 1200, -650]);
  await env.dispatch.put("hvdc-em6-" + date.replace(/-/g, ""), JSON.stringify({ series: SERIES, data }));
}

describe("syncHvdcHistory", () => {
  it("totals the energy sent each way by day, week, month and year", async () => {
    mockEmi([{ month: "199708" }, { month: "199709" }]);

    await syncHvdcHistory();

    expect(await getJson("aggregate-hvdc-daily-1997-08")).toEqual({ data: [day("1997-08-01", 12000, 240), day("1997-08-02", 12000, 240)] });
    expect(await getJson("aggregate-hvdc-daily-1997-09")).toEqual({ data: [day("1997-09-01", 12000, 240), day("1997-09-02", 12000, 240)] });
    expect(await getJson("aggregate-hvdc-weekly-1997")).toEqual({
      data: [dataPoint("1997-07-28", "1997-08-03", 24000, 480), dataPoint("1997-09-01", "1997-09-07", 24000, 480)],
    });
    expect(await getJson("aggregate-hvdc-monthly-1997")).toEqual({
      data: [dataPoint("1997-08-01", "1997-08-31", 24000, 480), dataPoint("1997-09-01", "1997-09-30", 24000, 480)],
    });
    expect(await getJson("aggregate-hvdc-annual")).toEqual({ data: [dataPoint("1997-01-01", "1997-12-31", 48000, 960)] });
    expect(await env.dispatch.get("aggregate-annual")).toBeNull();
    expect(await env.dispatch_kv.get("latestMeteredHvdcDate")).toBe("1997-09-30");
  });

  it("stores each day's flows by trading period", async () => {
    mockEmi([{ month: "199708" }]);

    await syncHvdcHistory();

    const stored = await getJson("hvdc-metered-19970801") as { series: string[]; data: unknown[][] };
    expect(stored.series).toEqual(SERIES);
    expect(stored.data).toHaveLength(48);
    expect(stored.data[0]).toEqual(["1997-08-01T00:00:00", 500, 10, null, null]);
  });

  it("starts at the metered generation's first month", async () => {
    const requests = mockEmi([{ month: "199610" }, { month: "199707" }, { month: "199708" }]);

    await syncHvdcHistory();

    expect(downloadedDates(requests)).toEqual(["199708"]);
    expect(await env.dispatch.get("aggregate-hvdc-daily-1997-07")).toBeNull();
  });

  it("doesn't download months it's already aggregated", async () => {
    mockEmi([{ month: "199708" }]);
    await syncHvdcHistory();

    const requests = mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncHvdcHistory();

    expect(downloadedDates(requests)).toEqual(["199709"]);
  });

  it("aggregates a month again when EMI republishes it, without moving the latest date back", async () => {
    mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncHvdcHistory();

    const requests = mockEmi([
      { month: "199708", north: 250, lastModified: "Thu, 15 Oct 2026 01:00:00 GMT" },
      { month: "199709" },
    ]);
    await syncHvdcHistory();

    expect(downloadedDates(requests)).toEqual(["199708"]);
    expect(await getJson("aggregate-hvdc-daily-1997-08")).toEqual({ data: [day("1997-08-01", 6000, 240), day("1997-08-02", 6000, 240)] });
    expect(await env.dispatch_kv.get("latestMeteredHvdcDate")).toBe("1997-09-30");
  });

  it("stops starting new months once it's run for 10 minutes, and carries on from there next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const files = [{ month: "199708" }, { month: "199709" }, { month: "199710" }];
    mockEmi(files, () => vi.setSystemTime(Date.now() + 6 * 60 * 1000));

    await syncHvdcHistory();

    expect(await env.dispatch_kv.get("latestMeteredHvdcDate")).toBe("1997-09-30");

    const requests = mockEmi(files);
    await syncHvdcHistory();

    expect(downloadedDates(requests)).toEqual(["199710"]);
  });

  describe("the days since EMI's latest month", () => {
    it("are aggregated from em6's half hours, today so far", async () => {
      mockEmi([{ month: "202609", days: ["2026-09-30"] }]);
      await storeEm6Day("2026-09-30", [999]);
      await storeEm6Day("2026-10-30", Array(48).fill(600));
      await storeEm6Day("2026-10-31", [700, 800]);

      await syncHvdcHistory();

      expect(await getJson("aggregate-hvdc-daily-2026-09")).toEqual({ data: [day("2026-09-30", 12000, 240)] });
      expect(await getJson("aggregate-hvdc-daily-2026-10")).toEqual({ data: [day("2026-10-30", 14400, 0), day("2026-10-31", 750, 0)] });
      expect(await getJson("aggregate-hvdc-monthly-2026")).toEqual({
        data: [dataPoint("2026-09-01", "2026-09-30", 12000, 240), dataPoint("2026-10-01", "2026-10-31", 15150, 0)],
      });
      expect(await getJson("aggregate-hvdc-annual")).toEqual({ data: [dataPoint("2026-01-01", "2026-12-31", 27150, 240)] });
    });

    it("are updated each run as em6 adds to them", async () => {
      mockEmi([{ month: "202609", days: ["2026-09-30"] }]);
      await storeEm6Day("2026-10-31", [700]);
      await syncHvdcHistory();

      await storeEm6Day("2026-10-31", [700, 800]);
      const requests = mockEmi([{ month: "202609", days: ["2026-09-30"] }]);
      await syncHvdcHistory();

      expect(downloadedDates(requests)).toEqual([]);
      expect(await getJson("aggregate-hvdc-daily-2026-10")).toEqual({ data: [day("2026-10-31", 750, 0)] });
    });

    it("are replaced by EMI's once it publishes their month", async () => {
      mockEmi([{ month: "202609", days: ["2026-09-30"] }]);
      await storeEm6Day("2026-10-01", [600]);
      await storeEm6Day("2026-11-01", [600]);
      await syncHvdcHistory();

      mockEmi([{ month: "202609", days: ["2026-09-30"] }, { month: "202610", days: ["2026-10-01"] }]);
      await syncHvdcHistory();

      expect(await getJson("aggregate-hvdc-daily-2026-10")).toEqual({ data: [day("2026-10-01", 12000, 240)] });
      expect(await getJson("aggregate-hvdc-daily-2026-11")).toEqual({ data: [day("2026-11-01", 300, 0)] });
      expect(await env.dispatch_kv.get("latestMeteredHvdcDate")).toBe("2026-10-31");
    });
  });
});
