import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { formatUnlistedCodesMessage, syncMeteredGeneration } from "./syncMeteredGeneration";
import { MeteredGenerationCode, MeteredSource } from "../services/meteredGeneration/meteredGeneration";
import { mockFetch } from "../testing/fetchMock";
import { downloadedDates, EMI_DATASETS_FILES_URL, EMI_DATASETS_LISTING_URL, emiBlobListing } from "../testing/fixtures";

const FOLDERS: Record<MeteredSource, string> = {
  Generation_MD: "Datasets/Wholesale/Generation/Generation_MD/",
  Embedded_generation: "Datasets/Wholesale/Metered_data/Embedded_generation/",
  Grid_import: "Datasets/Wholesale/Metered_data/Grid_import/",
};
const HEADERS: Record<MeteredSource, string> = {
  Generation_MD: "Site_Code,POC_Code,Nwk_Code,Gen_Code,Fuel_Code,Tech_Code,Trading_date",
  Embedded_generation: "POC,NWK_Code,Participant_Code,Loss_Code,Flow_Direction,Trading_date",
  Grid_import: "POC,NWK_Code,GENERATION_TYPE,TRADER,UNIT_MEASURE,FLOW_DIRECTION,STATUS,TRADING_DATE",
};
const NODE = "ATI2201 ATI0";

const codes: MeteredGenerationCode[] = [{ code: "ATI2201 atiamuri", node: NODE }];

type MonthlyFile = {
  month: string; // YYYYMM
  source?: MeteredSource; // defaults to Generation_MD
  days?: string[]; // trading dates, defaults to the 1st and 2nd of the month
  rows?: string[];
  lastModified?: string;
};

const fileName = (file: MonthlyFile) => `${FOLDERS[file.source ?? "Generation_MD"]}${file.month}_${file.source ?? "Generation_MD"}.csv`;

// Ātiamuri at a constant output, so it generates mw x 24 MWh a day
const row = (date: string, mw: number, gen = "atiamuri") =>
  `ATI,ATI2201,MRPL,${gen},Hydro,Hydro,${date},${Array(48).fill(mw * 500).join(",")},,`;

// Cobb in the embedded generation files, which have dates as dd/mm/yyyy until 2020
const embeddedRow = (date: string, mw: number) =>
  `STK0661,TASM,TRUS,COBB,I,${date.split("-").reverse().join("/")},${Array(48).fill(mw * 500).join(",")},,`;

const firstDays = (month: string) => [`${month.slice(0, 4)}-${month.slice(4)}-01`, `${month.slice(0, 4)}-${month.slice(4)}-02`];

function mockEmi(files: MonthlyFile[]) {
  return mockFetch({
    [EMI_DATASETS_LISTING_URL]: (request) => {
      const prefix = new URL(request.url).searchParams.get("prefix")!;
      return emiBlobListing(files
        .filter(file => fileName(file).startsWith(prefix))
        .map(file => ({ name: fileName(file), lastModified: file.lastModified })));
    },
    "https://hooks.slack.test/": () => new Response("ok"),
    [EMI_DATASETS_FILES_URL]: (request) => {
      const file = files.find(file => request.url === `${EMI_DATASETS_FILES_URL}${fileName(file)}`)!;
      const source = file.source ?? "Generation_MD";
      const rows = file.rows ?? (file.days ?? firstDays(file.month)).map(date => source === "Generation_MD" ? row(date, 10) : embeddedRow(date, 5));
      const header = HEADERS[source] + "," + Array.from({ length: 50 }, (_, i) => `TP${i + 1}`).join(",");
      return new Response([header, ...rows].join("\r\n") + "\r\n");
    },
  });
}

// the files downloaded, e.g. 199708_Generation_MD.csv
const downloadedFiles = (requests: Request[]) => requests
  .filter(request => request.url.startsWith(EMI_DATASETS_FILES_URL))
  .map(request => request.url.split("/").slice(-1)[0]);

const dataPoint = (from: string, to: string, mwh: number) => ({ from, to, nodes: { [NODE]: { g: mwh, l: 0 } } });
const day = (date: string, mwh: number) => dataPoint(date, date, mwh);

async function getAggregate(key: string) {
  return await (await env.dispatch.get(key))?.json();
}

const slackMessages = (requests: Request[]) => Promise.all(requests
  .filter(request => request.url.startsWith("https://hooks.slack.test/"))
  .map(async request => (await request.json() as { text: string }).text));

describe("syncMeteredGeneration", () => {
  it("totals each month's generation by day, week, month and year", async () => {
    mockEmi([{ month: "199708" }, { month: "199709" }]);

    await syncMeteredGeneration(codes);

    expect(await getAggregate("aggregate-daily-1997-08")).toEqual({ data: [day("1997-08-01", 240), day("1997-08-02", 240)] });
    expect(await getAggregate("aggregate-daily-1997-09")).toEqual({ data: [day("1997-09-01", 240), day("1997-09-02", 240)] });
    expect(await getAggregate("aggregate-weekly-1997")).toEqual({
      data: [dataPoint("1997-07-28", "1997-08-03", 480), dataPoint("1997-09-01", "1997-09-07", 480)],
    });
    expect(await getAggregate("aggregate-monthly-1997")).toEqual({
      data: [dataPoint("1997-08-01", "1997-08-31", 480), dataPoint("1997-09-01", "1997-09-30", 480)],
    });
    expect(await getAggregate("aggregate-annual")).toEqual({ data: [dataPoint("1997-01-01", "1997-12-31", 960)] });
  });

  it("stores each day's generation by trading period", async () => {
    mockEmi([{ month: "199708", rows: [row("1997-08-01", 10), row("1997-08-02", 20)] }]);

    await syncMeteredGeneration(codes);

    const day = await getAggregate("metered-19970801") as Record<string, unknown>;
    expect(Object.keys(day)).toHaveLength(48);
    expect(day["1997-08-01T00:00:00"]).toEqual([{ p: NODE, g: 10, l: 0 }]);
    expect(day["1997-08-01T23:30:00"]).toEqual([{ p: NODE, g: 10, l: 0 }]);
    expect((await getAggregate("metered-19970802") as Record<string, unknown>)["1997-08-02T12:00:00"]).toEqual([{ p: NODE, g: 20, l: 0 }]);
  });

  it("stops at the day before the dispatch aggregates start, and adds to that month's dispatch days", async () => {
    // 11 September 2020 onwards are already aggregated from the daily dispatch files
    await env.dispatch.put("aggregate-daily-2020-09", JSON.stringify({ data: [day("2020-09-10", 999), day("2020-09-11", 100)] }));
    const requests = mockEmi([
      { month: "202009", days: ["2020-09-10", "2020-09-11"] },
      { month: "202010" },
    ]);

    await syncMeteredGeneration(codes);

    expect(downloadedDates(requests)).toEqual(["202009"]);
    expect(await getAggregate("aggregate-daily-2020-09")).toEqual({ data: [day("2020-09-10", 240), day("2020-09-11", 100)] });
    expect(await getAggregate("aggregate-monthly-2020")).toEqual({ data: [dataPoint("2020-09-01", "2020-09-30", 340)] });
    expect(await env.dispatch.get("metered-20200910")).not.toBeNull();
    expect(await env.dispatch.get("metered-20200911")).toBeNull();
  });

  it("week totals span months aggregated in different runs", async () => {
    // Sunday 31 August and Monday 1 September 1997 are in different weeks, but Sunday 30 November 1997 and
    // Monday 1 December aren't, so check a week from 24 November
    mockEmi([{ month: "199711", days: ["1997-11-28"] }, { month: "199712", days: ["1997-12-01"] }]);
    await syncMeteredGeneration(codes);

    expect(await getAggregate("aggregate-weekly-1997")).toEqual({
      data: [dataPoint("1997-11-24", "1997-11-30", 240), dataPoint("1997-12-01", "1997-12-07", 240)],
    });
  });

  it("doesn't download months it's already aggregated", async () => {
    mockEmi([{ month: "199708" }]);
    await syncMeteredGeneration(codes);

    const requests = mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncMeteredGeneration(codes);

    expect(downloadedDates(requests)).toEqual(["199709"]);
  });

  it("aggregates a month again when EMI republishes it", async () => {
    mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncMeteredGeneration(codes);

    const requests = mockEmi([
      { month: "199708", rows: [row("1997-08-01", 20)], lastModified: "Thu, 15 Oct 2026 01:00:00 GMT" },
      { month: "199709" },
    ]);
    await syncMeteredGeneration(codes);

    expect(downloadedDates(requests)).toEqual(["199708"]);
    expect(await getAggregate("aggregate-daily-1997-08")).toEqual({ data: [day("1997-08-01", 480), day("1997-08-02", 240)] });
  });

  it("aggregates every month again when how a generator is attributed changes", async () => {
    mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncMeteredGeneration(codes);

    // only a note changing isn't enough
    let requests = mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncMeteredGeneration([{ ...codes[0], note: "a note" }]);
    expect(downloadedDates(requests)).toEqual([]);

    requests = mockEmi([{ month: "199708" }, { month: "199709" }]);
    await syncMeteredGeneration([{ code: "ATI2201 atiamuri", excluded: "a reason" }]);

    expect(downloadedDates(requests)).toEqual(["199708", "199709"]);
    expect(await getAggregate("aggregate-daily-1997-08")).toEqual({
      data: [{ from: "1997-08-01", to: "1997-08-01", nodes: {} }, { from: "1997-08-02", to: "1997-08-02", nodes: {} }],
    });
  });

  it("reports generators that aren't listed, leaving them out", async () => {
    const requests = mockEmi([
      { month: "199708", rows: [row("1997-08-01", 10), row("1997-08-01", 10, "new_plant")] },
      { month: "199709", rows: [row("1997-09-01", 20, "new_plant")] },
    ]);

    await syncMeteredGeneration(codes);

    expect(await getAggregate("aggregate-daily-1997-08")).toEqual({ data: [day("1997-08-01", 240)] });
    expect(await slackMessages(requests)).toEqual([formatUnlistedCodesMessage(new Map([
      ["ATI2201 new_plant", { mwh: 720, months: ["199708", "199709"] }],
    ]))]);
  });

  it("doesn't report anything when every generator is listed", async () => {
    const requests = mockEmi([{ month: "199708" }]);

    await syncMeteredGeneration(codes);

    expect(await slackMessages(requests)).toEqual([]);
  });

  it("aggregates at most 60 months a run, oldest first", async () => {
    const months = Array.from({ length: 62 }, (_, i) => {
      const date = new Date(Date.UTC(1997, 7 + i, 1));
      return { month: `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}` };
    });
    let requests = mockEmi(months);
    await syncMeteredGeneration(codes);
    expect(downloadedDates(requests)).toEqual(months.slice(0, 60).map(file => file.month));

    requests = mockEmi(months);
    await syncMeteredGeneration(codes);
    expect(downloadedDates(requests)).toEqual(["200208", "200209"]);
  });

  describe("with generators from the embedded generation data", () => {
    const COBB = "STK0661 COB0";
    const withCobb: MeteredGenerationCode[] = [
      ...codes,
      { code: "STK0661 cobb", source: "Embedded_generation", node: COBB, from: "2015-02-01" },
    ];

    it("adds their generation to the days they're listed for", async () => {
      mockEmi([
        { month: "201502" },
        { month: "201502", source: "Embedded_generation" },
      ]);

      await syncMeteredGeneration(withCobb);

      expect(await getAggregate("aggregate-daily-2015-02")).toEqual({
        data: ["2015-02-01", "2015-02-02"].map(date => ({ from: date, to: date, nodes: { [NODE]: { g: 240, l: 0 }, [COBB]: { g: 120, l: 0 } } })),
      });
      expect((await getAggregate("metered-20150201") as Record<string, unknown>)["2015-02-01T00:00:00"]).toEqual([
        { p: NODE, g: 10, l: 0 },
        { p: COBB, g: 5, l: 0 },
      ]);
    });

    it("only downloads their files for the months they're listed for", async () => {
      const requests = mockEmi([
        { month: "201501" },
        { month: "201501", source: "Embedded_generation" },
        { month: "201502" },
        { month: "201502", source: "Embedded_generation" },
      ]);

      await syncMeteredGeneration(withCobb);

      expect(downloadedFiles(requests)).toEqual([
        "201501_Generation_MD.csv",
        "201502_Generation_MD.csv",
        "201502_Embedded_generation.csv",
      ]);
    });

    it("doesn't list or download them when no code is from the embedded generation data", async () => {
      const requests = mockEmi([{ month: "201502" }, { month: "201502", source: "Embedded_generation" }]);

      await syncMeteredGeneration(codes);

      expect(requests.filter(request => request.url.includes("Embedded_generation"))).toEqual([]);
    });

    it("aggregates a month again when EMI republishes its embedded generation file", async () => {
      mockEmi([{ month: "201502" }, { month: "201502", source: "Embedded_generation" }]);
      await syncMeteredGeneration(withCobb);

      const requests = mockEmi([
        { month: "201502" },
        { month: "201502", source: "Embedded_generation", days: ["2015-02-01"], lastModified: "Thu, 15 Oct 2026 01:00:00 GMT" },
      ]);
      await syncMeteredGeneration(withCobb);

      expect(downloadedFiles(requests)).toEqual(["201502_Generation_MD.csv", "201502_Embedded_generation.csv"]);
      expect(await getAggregate("aggregate-daily-2015-02")).toEqual({
        data: [
          { from: "2015-02-01", to: "2015-02-01", nodes: { [NODE]: { g: 240, l: 0 }, [COBB]: { g: 120, l: 0 } } },
          day("2015-02-02", 240),
        ],
      });
    });

    it("doesn't aggregate a month that only has an embedded generation file", async () => {
      const requests = mockEmi([{ month: "201502", source: "Embedded_generation" }]);

      await syncMeteredGeneration(withCobb);

      expect(downloadedFiles(requests)).toEqual([]);
    });
  });

  it("ignores null characters padding empty trading periods", async () => {
    mockEmi([{ month: "201506", rows: [row("2015-06-01", 10).replace(/,,$/, ",\0,\0")] }]);

    await syncMeteredGeneration(codes);

    expect(await getAggregate("aggregate-daily-2015-06")).toEqual({ data: [day("2015-06-01", 240)] });
  });
});

describe("formatUnlistedCodesMessage", () => {
  it("lists each code with its generation and the months it's in", () => {
    expect(formatUnlistedCodesMessage(new Map([
      ["ABC0111 new_plant", { mwh: 12345, months: ["199708", "199709", "199710"] }],
      ["XYZ0111 other_plant", { mwh: 500, months: ["200101"] }],
    ]))).toBe(
      "⚠️ EMI's metered generation has generators that aren't in meteredGenerationCodes.json, so their generation "
      + "is left out of the aggregates. Add each one with the unit it belongs to (or why it's excluded):\n"
      + "• `ABC0111 new_plant`: 12.3 GWh (199708-199710)\n"
      + "• `XYZ0111 other_plant`: 0.5 GWh (200101)",
    );
  });
});
