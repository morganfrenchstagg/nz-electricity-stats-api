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

// a row of the grid import files, whose columns were uppercase until 2020. type is a network's (GN), a direct
// connection's (GD) or a generator's own (GG)
function gridImportRow(poc: string, network: string, date: string, kwh: number[], { type = "GN", trader = "TPNZ" } = {}) {
  return { POC: poc, NWK_Code: network, GENERATION_TYPE: type, TRADER: trader, UNIT_MEASURE: "kWh", FLOW_DIRECTION: "I", STATUS: "F", TRADING_DATE: date, ...tradingPeriods(kwh) };
}

// a row of the grid export files, which are like the grid import files'
function gridExportRow(poc: string, network: string, date: string, kwh: number[], options: { type?: string, trader?: string } = {}) {
  return { ...gridImportRow(poc, network, date, kwh, options), FLOW_DIRECTION: "X" };
}

// a row of the unit-level generation files
function unitLevelRow(poc: string, unit: string, date: string, kwh: number[]) {
  return { POC: poc, Unit_Code: unit, Participant_Code: "GENE", Gen_Measure: "kWh", Flow_Direction: "I", Gen_Type: "F", Trading_Date: date, ...tradingPeriods(kwh) };
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

  it("is the point of connection and the unit code in the unit-level generation data", () => {
    expect(getMeteredCode(unitLevelRow("HLY2201", "UN5", "2020-09-01", []), "Unit_level_generation")).toBe("HLY2201 un5");
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

    // Cobb is embedded behind STK0661, so it's added back to the load there (see the load tests below)
    expect(energy(generation)).toEqual(new Map([
      ["2015-01-31", { "ATI2201 ATI0": { g: 48, l: 0 } }],
      ["2015-02-01", { "ATI2201 ATI0": { g: 48, l: 0 }, "STK0661 COB0": { g: 24, l: 0 }, "STK0661": { g: 0, l: 24 }, "KAW0112 ONU0": { g: 12, l: 0 } }],
    ]));
    expect(generation.days.get("2015-02-01")!.periods["2015-02-01T00:00:00"]).toEqual([
      { p: "ATI2201 ATI0", g: 2, l: 0 },
      { p: "STK0661 COB0", g: 1, l: 0 },
      { p: "STK0661", g: 0, l: 1 },
      { p: "KAW0112 ONU0", g: 0.5, l: 0 },
    ]);
  });

  it("fills in units Generation_MD leaves out from the unit-level generation data, for the days their codes are listed", () => {
    // Generation_MD has none of Huntly in September 2020
    const huntly: MeteredGenerationCode[] = [
      { code: "HLY2201 huntly_e3p", node: "HLY2201 HLY5", to: "2020-08-31" },
      { code: "HLY2201 un5", source: "Unit_level_generation", node: "HLY2201 HLY5", from: "2020-09-01" },
    ];

    const generation = calculateMeteredGeneration([
      { source: "Generation_MD", records: [row("HLY2201", "huntly_e3p", "2020-08-31", allDay(150000))] },
      { source: "Unit_level_generation", records: [unitLevelRow("HLY2201", "UN5", "2020-08-31", allDay(150000)), unitLevelRow("HLY2201", "UN5", "2020-09-01", allDay(180000))] },
    ], huntly);

    expect(energy(generation)).toEqual(new Map([
      ["2020-08-31", { "HLY2201 HLY5": { g: 7200, l: 0 } }],
      ["2020-09-01", { "HLY2201 HLY5": { g: 8640, l: 0 } }],
    ]));
  });

  it("only reads what the embedded generation data has generators inject (I), not what's used at their connection (X)", () => {
    const generation = calculateMeteredGeneration([{ source: "Embedded_generation", records: [
      embeddedRow("STK0661", "COBB", "01/02/2015", allDay(500)),
      embeddedRow("STK0661", "COBB", "01/02/2015", allDay(100), "X"),
    ] }], codes);

    expect(energy(generation).get("2015-02-01")).toEqual({ "STK0661 COB0": { g: 24, l: 0 }, "STK0661": { g: 0, l: 24 } });
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

    expect(energy(generation).get("2015-02-01")).toEqual({ "STK0661 COB0": { g: 0.5, l: 0 }, "STK0661": { g: 0, l: 0.5 } });
  });
});

describe("calculateMeteredGeneration's load", () => {
  const loadCodes: MeteredGenerationCode[] = [
    ...codes,
    { code: "TWH0331 te_uku", node: "TWH0331 TUK0" },
    { code: "TUI1101 waikaremoana", node: "TUI1101 TUI0" },
  ];

  const loadOf = (generation: MeteredGeneration, date: string) => Object.fromEntries(Object.entries(energy(generation).get(date)!)
    .filter(([node]) => !node.includes(" ")));

  it("is what each point of connection took from the grid, less what it injected", () => {
    const generation = calculateMeteredGeneration([
      { source: "Grid_export", records: [
        gridExportRow("ABY0111", "ALPE", "01/08/2005", allDay(1000)),
        gridExportRow("TWH0331", "WAIK", "01/08/2005", [5000, 0]),
      ] },
      { source: "Grid_import", records: [gridImportRow("TWH0331", "WAIK", "01/08/2005", [0, 3000])] },
    ], loadCodes);

    expect(energy(generation).get("2005-08-01")).toEqual({ ABY0111: { g: 0, l: 48 }, TWH0331: { g: 0, l: 2 } });
    expect(generation.days.get("2005-08-01")!.periods["2005-08-01T00:30:00"]).toEqual([
      { p: "ABY0111", g: 0, l: 2 },
      { p: "TWH0331", g: 0, l: -6 },
    ]);
  });

  it("adds together a point of connection's networks and direct connections", () => {
    const generation = calculateMeteredGeneration([{ source: "Grid_export", records: [
      gridExportRow("GLN0332", "NZST", "01/08/2005", allDay(1000)),
      gridExportRow("GLN0332", "COUP", "01/08/2005", allDay(500), { type: "EN" }),
      gridExportRow("GLN0331", "NZST", "01/08/2005", allDay(250), { type: "GD" }),
    ] }], loadCodes);

    expect(loadOf(generation, "2005-08-01")).toEqual({ GLN0332: { g: 0, l: 72 }, GLN0331: { g: 0, l: 12 } });
  });

  it("leaves out generators' own connections, as the dispatch data doesn't have their station load", () => {
    const generation = calculateMeteredGeneration([
      { source: "Grid_export", records: [gridExportRow("ATI2201", "MRPL", "01/08/2005", allDay(100), { type: "GG" })] },
      { source: "Grid_import", records: [
        gridImportRow("ATI2201", "MRPL", "01/08/2005", allDay(25000), { type: "GG" }),
        gridImportRow("NGA0331", "TOPE", "01/08/2005", allDay(1000), { type: "EG" }),
      ] },
    ], loadCodes);

    expect(energy(generation).get("2005-08-01")).toEqual({});
  });

  it("adds back the generators metered behind it, which the dispatch data has generating at the node", () => {
    // Te Uku is behind the Waikato network's connection at TWH0331, but Tuai connects to the grid at TUI1101 on its own
    const generation = calculateMeteredGeneration([
      { source: "Generation_MD", records: [
        row("TWH0331", "te_uku", "2015-08-01", allDay(10000), { network: "WAIK" }),
        row("TUI1101", "waikaremoana", "2015-08-01", allDay(30000), { network: "GENE" }),
      ] },
      { source: "Grid_export", records: [
        gridExportRow("TWH0331", "WAIK", "2015-08-01", allDay(2000)),
        gridExportRow("TUI1101", "EAST", "2015-08-01", allDay(1000)),
      ] },
      { source: "Grid_import", records: [
        gridImportRow("TWH0331", "WAIK", "2015-08-01", allDay(5000)),
        gridImportRow("TUI1101", "GENE", "2015-08-01", allDay(30000), { type: "GG" }),
      ] },
    ], loadCodes);

    expect(energy(generation).get("2015-08-01")).toEqual({
      "TWH0331 TUK0": { g: 480, l: 0 },
      "TUI1101 TUI0": { g: 1440, l: 0 },
      TWH0331: { g: 0, l: 336 },
      TUI1101: { g: 0, l: 48 },
    });
  });

  it("adds back the generators in the embedded generation data, and the grid import data's", () => {
    const generation = calculateMeteredGeneration([
      { source: "Embedded_generation", records: [embeddedRow("STK0661", "COBB", "01/02/2015", allDay(500))] },
      { source: "Grid_export", records: [
        gridExportRow("STK0661", "TASM", "01/02/2015", allDay(2000)),
        gridExportRow("KAW0112", "SKOG", "01/02/2015", allDay(100)),
      ] },
      { source: "Grid_import", records: [gridImportRow("KAW0112", "SKOG", "01/02/2015", allDay(250))] },
    ], loadCodes);

    expect(loadOf(generation, "2015-02-01")).toEqual({ STK0661: { g: 0, l: 120 }, KAW0112: { g: 0, l: 4.8 } });
  });

  it("doesn't add back excluded generators, which the dispatch data nets from the load", () => {
    const generation = calculateMeteredGeneration([
      { source: "Generation_MD", records: [row("CYD0331", "teviot", "2015-08-01", allDay(3000), { network: "DUNE" })] },
      { source: "Grid_import", records: [gridImportRow("CYD0331", "DUNE", "2015-08-01", allDay(2000))] },
    ], loadCodes);

    expect(energy(generation).get("2015-08-01")).toEqual({ CYD0331: { g: 0, l: -96 } });
  });

  it("adds back embedded generators' periods by the clock before 2009, where Generation_MD numbered them that way", () => {
    // the day daylight saving started, when the clock skipped 02:00-02:59
    const generation = calculateMeteredGeneration([
      { source: "Generation_MD", records: [row("TWH0331", "te_uku", "2008-09-28", [1000, 1000, 1000, 1000, undefined, undefined, ...Array(40).fill(1000)] as number[], { network: "WAIK" })] },
      { source: "Grid_export", records: [gridExportRow("TWH0331", "WAIK", "28/09/2008", Array(46).fill(500))] },
    ], loadCodes);
    const { periods } = generation.days.get("2008-09-28")!;

    expect(loadOf(generation, "2008-09-28")).toEqual({ TWH0331: { g: 0, l: 67 } });
    expect(Object.keys(periods)).toHaveLength(46);
    expect(periods["2008-09-28T03:00:00"]).toContainEqual({ p: "TWH0331", g: 0, l: 3 });
  });

  it("only counts a connection once when it's listed under two retailers with the same values", () => {
    const generation = calculateMeteredGeneration([{ source: "Grid_export", records: [
      gridExportRow("BDE0111", "RAYN", "01/11/2002", allDay(4000), { type: "GD", trader: "MERI" }),
      gridExportRow("BDE0111", "RAYN", "01/11/2002", allDay(4000), { type: "GD", trader: "TRUS" }),
      gridExportRow("OTA1102", "CTCT", "01/11/2002", allDay(500), { type: "GD" }),
      gridExportRow("OTA1102", "CTCT", "01/11/2002", allDay(250), { type: "GD" }),
    ] }], loadCodes);

    expect(energy(generation).get("2002-11-01")).toEqual({ BDE0111: { g: 0, l: 192 }, OTA1102: { g: 0, l: 36 } });
  });

  it("leaves out a point of connection that only injected what's added back", () => {
    const generation = calculateMeteredGeneration([
      { source: "Grid_import", records: [gridImportRow("KAW0112", "SKOG", "01/02/2015", allDay(250))] },
    ], loadCodes);

    expect(energy(generation).get("2015-02-01")).toEqual({ "KAW0112 ONU0": { g: 12, l: 0 } });
    expect(generation.days.get("2015-02-01")!.periods["2015-02-01T00:00:00"]).toEqual([{ p: "KAW0112 ONU0", g: 0.5, l: 0 }]);
  });
});
