import { describe, expect, it } from "vitest";

import { calculateMeteredGeneration, getMeteredCode, MeteredFile, MeteredGeneration, MeteredGenerationCode } from "./meteredGeneration";

const codes: MeteredGenerationCode[] = [
  { code: "ATI2201 atiamuri", node: "ATI2201 ATI0" },
  { code: "TKA0111 tekapo_a", node: "TKA0111 TKA0", to: "2011-05-31" },
  { code: "TKA0111 tekapo_a", node: "TKA0111 TKA1", from: "2011-06-01" },
  { code: "CYD0331 teviot", excluded: "Teviot isn't in the dispatch data" },
  { code: "STK0661 cobb", source: "Embedded_generation", node: "STK0661 COB0", from: "2015-02-01" },
  { code: "KAW0112 skog", source: "Grid_import", node: "KAW0112 ONU0" },
];

// a generator's kWh in each trading period (48 on most days), as the files' TP1-TP50 columns
const tradingPeriods = (kwh: (number | string)[]) =>
  Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`TP${i + 1}`, kwh[i] === undefined ? "" : `${kwh[i]}`]));

// a row of the Generation_MD files
function row(poc: string, gen: string, date: string, kwh: number[], { network = "MRPL", dateColumn = "Trading_date" } = {}) {
  return { Site_Code: poc.slice(0, 3), POC_Code: poc, Nwk_Code: network, Gen_Code: gen, Fuel_Code: "Hydro", Tech_Code: "Hydro", [dateColumn]: date, ...tradingPeriods(kwh) };
}

// a row of the embedded generation files, which have dates as dd/mm/yyyy until 2020
function embeddedRow(poc: string, loss: string, date: string, kwh: (number | string)[], direction = "I") {
  return { POC: poc, NWK_Code: "TASM", Participant_Code: "TRUS", Loss_Code: loss, Flow_Direction: direction, Trading_date: date, ...tradingPeriods(kwh) };
}

// a row of the grid import files, whose columns were uppercase until 2020
function gridImportRow(poc: string, network: string, date: string, kwh: number[]) {
  return { POC: poc, NWK_Code: network, GENERATION_TYPE: "GN", TRADER: "TPNZ", UNIT_MEASURE: "kWh", FLOW_DIRECTION: "I", STATUS: "F", TRADING_DATE: date, ...tradingPeriods(kwh) };
}

// Generation_MD's file for a month
const generationMd = (...records: Record<string, string>[]): MeteredFile[] => [{ source: "Generation_MD", records }];

const allDay = (kwh: number) => Array(48).fill(kwh);

// each day's energy by node
const energy = ({ days }: MeteredGeneration) => new Map([...days].map(([date, day]) => [date, day.energy]));

describe("getMeteredCode", () => {
  it("is the point of connection and the lowercased generator code", () => {
    expect(getMeteredCode(row("THI2201", "Te_Mihi", "2014-01-01", []))).toBe("THI2201 te_mihi");
  });

  it("is the point of connection and the loss code in the embedded generation data, or the network code in the grid import data", () => {
    expect(getMeteredCode(embeddedRow("STK0661", "COBB", "01/02/2015", []), "Embedded_generation")).toBe("STK0661 cobb");
    expect(getMeteredCode(gridImportRow("KAW0112", "SKOG", "01/02/2015", []), "Grid_import")).toBe("KAW0112 skog");
  });
});

describe("calculateMeteredGeneration", () => {
  it("totals each day's trading periods (kWh) by node in MWh", () => {
    const generation = calculateMeteredGeneration(generationMd(
      row("ATI2201", "atiamuri", "1997-08-01", allDay(25000)),
      row("ATI2201", "atiamuri", "1997-08-02", [10000, 20000]),
    ), codes);

    expect(energy(generation)).toEqual(new Map([
      ["1997-08-01", { "ATI2201 ATI0": { g: 1200, l: 0 } }],
      ["1997-08-02", { "ATI2201 ATI0": { g: 30, l: 0 } }],
    ]));
    expect(generation.unlisted).toEqual(new Map());
  });

  it("gives each node's average generation (MW) in each trading period, by when it starts", () => {
    const { days } = calculateMeteredGeneration(generationMd(
      row("ATI2201", "atiamuri", "1997-08-01", [10000, 20000]),
      row("TKA0111", "tekapo_a", "1997-08-01", [0, 5000]),
    ), codes);

    expect(days.get("1997-08-01")!.periods).toEqual({
      "1997-08-01T00:00:00": [{ p: "ATI2201 ATI0", g: 20, l: 0 }],
      "1997-08-01T00:30:00": [{ p: "ATI2201 ATI0", g: 40, l: 0 }, { p: "TKA0111 TKA0", g: 10, l: 0 }],
    });
  });

  it("includes the extra trading periods on the day daylight saving ends, repeating the hour's start times", () => {
    const { days } = calculateMeteredGeneration(generationMd(row("ATI2201", "atiamuri", "2020-04-05", Array(50).fill(1000))), codes);
    const { energy, periods } = days.get("2020-04-05")!;

    expect(energy).toEqual({ "ATI2201 ATI0": { g: 50, l: 0 } });
    expect(Object.keys(periods)).toHaveLength(48);
    expect(periods["2020-04-05T02:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 2, l: 0 }, { p: "ATI2201 ATI0", g: 2, l: 0 }]);
  });

  it("starts the periods by the clock before 2009, when EMI numbered them that way", () => {
    // 48 periods on the day daylight saving ended, and the skipped hour blank on the day it started
    const ended = Array(48).fill(1000);
    const started = [1000, 1000, 1000, 1000, undefined, undefined, ...Array(40).fill(1000)];
    const { days } = calculateMeteredGeneration(generationMd(
      row("ATI2201", "atiamuri", "2006-03-19", ended),
      row("ATI2201", "atiamuri", "2006-10-01", started as number[]),
    ), codes);

    expect(Object.keys(days.get("2006-03-19")!.periods)).toHaveLength(48);
    expect(Object.keys(days.get("2006-03-19")!.periods).slice(4, 6)).toEqual(["2006-03-19T02:00:00", "2006-03-19T02:30:00"]);
    expect(Object.keys(days.get("2006-03-19")!.periods)[47]).toBe("2006-03-19T23:30:00");
    expect(Object.keys(days.get("2006-10-01")!.periods).slice(3, 5)).toEqual(["2006-10-01T01:30:00", "2006-10-01T03:00:00"]);
  });

  it("adds together a generator's rows under different network codes", () => {
    const generation = calculateMeteredGeneration(generationMd(
      row("ATI2201", "atiamuri", "1997-08-01", allDay(1000), { network: "MRPL" }),
      row("ATI2201", "Atiamuri", "1997-08-01", allDay(500), { network: "WAIK" }),
    ), codes);

    expect(energy(generation).get("1997-08-01")).toEqual({ "ATI2201 ATI0": { g: 72, l: 0 } });
    expect(generation.days.get("1997-08-01")!.periods["1997-08-01T00:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 3, l: 0 }]);
  });

  it("counts trading periods where a generator used more than it generated as load", () => {
    const generation = calculateMeteredGeneration(generationMd(row("ATI2201", "atiamuri", "1997-08-01", [-500, -500, 3000])), codes);

    expect(energy(generation).get("1997-08-01")).toEqual({ "ATI2201 ATI0": { g: 3, l: 1 } });
    expect(generation.days.get("1997-08-01")!.periods["1997-08-01T00:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 0, l: 1 }]);
  });

  it("attributes a generator to the unit listed for each day", () => {
    const generation = calculateMeteredGeneration(generationMd(
      row("TKA0111", "tekapo_a", "2011-05-31", allDay(1000)),
      row("TKA0111", "tekapo_a", "2011-06-01", allDay(1000)),
    ), codes);

    expect(energy(generation).get("2011-05-31")).toEqual({ "TKA0111 TKA0": { g: 48, l: 0 } });
    expect(energy(generation).get("2011-06-01")).toEqual({ "TKA0111 TKA1": { g: 48, l: 0 } });
  });

  it("leaves out excluded generators without reporting them", () => {
    const generation = calculateMeteredGeneration(generationMd(row("CYD0331", "teviot", "2020-01-01", allDay(1000))), codes);

    expect(generation.days).toEqual(new Map([["2020-01-01", { energy: {}, periods: {} }]]));
    expect(generation.unlisted).toEqual(new Map());
  });

  it("leaves out and reports generators that aren't listed, unless they had no generation", () => {
    const generation = calculateMeteredGeneration(generationMd(
      row("ABC0111", "new_plant", "2020-01-01", allDay(1000)),
      row("ABC0111", "new_plant", "2020-01-02", allDay(1000)),
      row("XYZ0111", "idle_plant", "2020-01-01", allDay(0)),
      row("ATI2201", "atiamuri", "2020-01-01", allDay(1000)),
    ), codes);

    expect(energy(generation)).toEqual(new Map([
      ["2020-01-01", { "ATI2201 ATI0": { g: 48, l: 0 } }],
      ["2020-01-02", {}],
    ]));
    expect(generation.unlisted).toEqual(new Map([["ABC0111 new_plant", 96]]));
  });

  it("reads the trading date from either version of its column", () => {
    const { days } = calculateMeteredGeneration(generationMd(
      row("ATI2201", "atiamuri", "2014-01-01", allDay(1000), { dateColumn: "Trading_date" }),
      row("ATI2201", "atiamuri", "2024-01-01", allDay(1000), { dateColumn: "Trading_Date" }),
    ), codes);

    expect([...days.keys()]).toEqual(["2014-01-01", "2024-01-01"]);
  });

  it("fills in generators from the other datasets' files for the days their codes are listed", () => {
    const generation = calculateMeteredGeneration([
      { source: "Generation_MD", records: [row("ATI2201", "atiamuri", "2015-01-31", allDay(1000)), row("ATI2201", "atiamuri", "2015-02-01", allDay(1000))] },
      { source: "Embedded_generation", records: [embeddedRow("STK0661", "COBB", "31/01/2015", allDay(500)), embeddedRow("STK0661", "COBB", "01/02/2015", allDay(500))] },
      { source: "Grid_import", records: [gridImportRow("KAW0112", "SKOG", "01/02/2015", allDay(250))] },
    ], codes);

    expect(energy(generation)).toEqual(new Map([
      ["2015-01-31", { "ATI2201 ATI0": { g: 48, l: 0 } }],
      ["2015-02-01", { "ATI2201 ATI0": { g: 48, l: 0 }, "STK0661 COB0": { g: 24, l: 0 }, "KAW0112 ONU0": { g: 12, l: 0 } }],
    ]));
    expect(generation.days.get("2015-02-01")!.periods["2015-02-01T00:00:00"]).toEqual([
      { p: "ATI2201 ATI0", g: 2, l: 0 },
      { p: "STK0661 COB0", g: 1, l: 0 },
      { p: "KAW0112 ONU0", g: 0.5, l: 0 },
    ]);
  });

  it("only reads what the embedded generation data has generators inject (I), not what's used at their connection (X)", () => {
    const generation = calculateMeteredGeneration([{ source: "Embedded_generation", records: [
      embeddedRow("STK0661", "COBB", "01/02/2015", allDay(500)),
      embeddedRow("STK0661", "COBB", "01/02/2015", allDay(100), "X"),
    ] }], codes);

    expect(energy(generation).get("2015-02-01")).toEqual({ "STK0661 COB0": { g: 24, l: 0 } });
  });

  it("only reports codes that aren't listed from Generation_MD, as the other datasets are only read for the codes listed", () => {
    const generation = calculateMeteredGeneration([
      { source: "Generation_MD", records: [row("ABC0111", "new_plant", "2020-01-01", allDay(1000))] },
      { source: "Embedded_generation", records: [embeddedRow("XYZ0111", "SOLAR1", "01/01/2020", allDay(1000))] },
    ], codes);

    expect(energy(generation).get("2020-01-01")).toEqual({});
    expect(generation.unlisted).toEqual(new Map([["ABC0111 new_plant", 48]]));
  });

  it("numbers the other datasets' periods since midnight before 2009, where Generation_MD numbered them by the clock", () => {
    // the day daylight saving started, when the clock skipped 02:00-02:59
    const { days } = calculateMeteredGeneration([
      { source: "Generation_MD", records: [row("ATI2201", "atiamuri", "2008-09-28", [1000, 1000, 1000, 1000, undefined, undefined, ...Array(40).fill(1000)] as number[])] },
      { source: "Grid_import", records: [gridImportRow("KAW0112", "SKOG", "28/09/2008", Array(46).fill(500))] },
    ], codes);
    const { energy, periods } = days.get("2008-09-28")!;

    expect(energy).toEqual({ "ATI2201 ATI0": { g: 44, l: 0 }, "KAW0112 ONU0": { g: 23, l: 0 } });
    expect(Object.keys(periods)).toHaveLength(46);
    expect(periods["2008-09-28T03:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 2, l: 0 }, { p: "KAW0112 ONU0", g: 1, l: 0 }]);
  });

  it("leaves out NULL trading periods", () => {
    const generation = calculateMeteredGeneration([{ source: "Embedded_generation", records: [
      embeddedRow("STK0661", "COBB", "01/02/2015", ["NULL", 500, "NULL"]),
    ] }], codes);

    expect(energy(generation).get("2015-02-01")).toEqual({ "STK0661 COB0": { g: 0.5, l: 0 } });
  });
});
