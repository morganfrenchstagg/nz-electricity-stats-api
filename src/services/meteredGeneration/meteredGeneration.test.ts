import { describe, expect, it } from "vitest";

import { calculateMeteredGeneration, getMeteredCode, MeteredGeneration, MeteredGenerationCode } from "./meteredGeneration";

const codes: MeteredGenerationCode[] = [
  { code: "ATI2201 atiamuri", node: "ATI2201 ATI0" },
  { code: "TKA0111 tekapo_a", node: "TKA0111 TKA0", to: "2011-05-31" },
  { code: "TKA0111 tekapo_a", node: "TKA0111 TKA1", from: "2011-06-01" },
  { code: "CYD0331 teviot", excluded: "Teviot isn't in the dispatch data" },
];

// a row of the metered generation files, with the generator's kWh in each trading period (48 on most days)
function row(poc: string, gen: string, date: string, kwh: number[], { network = "MRPL", dateColumn = "Trading_date" } = {}) {
  const periods = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`TP${i + 1}`, kwh[i] === undefined ? "" : `${kwh[i]}`]));
  return { Site_Code: poc.slice(0, 3), POC_Code: poc, Nwk_Code: network, Gen_Code: gen, Fuel_Code: "Hydro", Tech_Code: "Hydro", [dateColumn]: date, ...periods };
}

const allDay = (kwh: number) => Array(48).fill(kwh);

// each day's energy by node
const energy = ({ days }: MeteredGeneration) => new Map([...days].map(([date, day]) => [date, day.energy]));

describe("getMeteredCode", () => {
  it("is the point of connection and the lowercased generator code", () => {
    expect(getMeteredCode(row("THI2201", "Te_Mihi", "2014-01-01", []))).toBe("THI2201 te_mihi");
  });
});

describe("calculateMeteredGeneration", () => {
  it("totals each day's trading periods (kWh) by node in MWh", () => {
    const generation = calculateMeteredGeneration([
      row("ATI2201", "atiamuri", "1997-08-01", allDay(25000)),
      row("ATI2201", "atiamuri", "1997-08-02", [10000, 20000]),
    ], codes);

    expect(energy(generation)).toEqual(new Map([
      ["1997-08-01", { "ATI2201 ATI0": { g: 1200, l: 0 } }],
      ["1997-08-02", { "ATI2201 ATI0": { g: 30, l: 0 } }],
    ]));
    expect(generation.unlisted).toEqual(new Map());
  });

  it("gives each node's average generation (MW) in each trading period, by when it starts", () => {
    const { days } = calculateMeteredGeneration([
      row("ATI2201", "atiamuri", "1997-08-01", [10000, 20000]),
      row("TKA0111", "tekapo_a", "1997-08-01", [0, 5000]),
    ], codes);

    expect(days.get("1997-08-01")!.periods).toEqual({
      "1997-08-01T00:00:00": [{ p: "ATI2201 ATI0", g: 20, l: 0 }],
      "1997-08-01T00:30:00": [{ p: "ATI2201 ATI0", g: 40, l: 0 }, { p: "TKA0111 TKA0", g: 10, l: 0 }],
    });
  });

  it("includes the extra trading periods on the day daylight saving ends, repeating the hour's start times", () => {
    const { days } = calculateMeteredGeneration([row("ATI2201", "atiamuri", "2020-04-05", Array(50).fill(1000))], codes);
    const { energy, periods } = days.get("2020-04-05")!;

    expect(energy).toEqual({ "ATI2201 ATI0": { g: 50, l: 0 } });
    expect(Object.keys(periods)).toHaveLength(48);
    expect(periods["2020-04-05T02:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 2, l: 0 }, { p: "ATI2201 ATI0", g: 2, l: 0 }]);
  });

  it("starts the periods by the clock before 2009, when EMI numbered them that way", () => {
    // 48 periods on the day daylight saving ended, and the skipped hour blank on the day it started
    const ended = Array(48).fill(1000);
    const started = [1000, 1000, 1000, 1000, undefined, undefined, ...Array(40).fill(1000)];
    const { days } = calculateMeteredGeneration([
      row("ATI2201", "atiamuri", "2006-03-19", ended),
      row("ATI2201", "atiamuri", "2006-10-01", started as number[]),
    ], codes);

    expect(Object.keys(days.get("2006-03-19")!.periods)).toHaveLength(48);
    expect(Object.keys(days.get("2006-03-19")!.periods).slice(4, 6)).toEqual(["2006-03-19T02:00:00", "2006-03-19T02:30:00"]);
    expect(Object.keys(days.get("2006-03-19")!.periods)[47]).toBe("2006-03-19T23:30:00");
    expect(Object.keys(days.get("2006-10-01")!.periods).slice(3, 5)).toEqual(["2006-10-01T01:30:00", "2006-10-01T03:00:00"]);
  });

  it("adds together a generator's rows under different network codes", () => {
    const generation = calculateMeteredGeneration([
      row("ATI2201", "atiamuri", "1997-08-01", allDay(1000), { network: "MRPL" }),
      row("ATI2201", "Atiamuri", "1997-08-01", allDay(500), { network: "WAIK" }),
    ], codes);

    expect(energy(generation).get("1997-08-01")).toEqual({ "ATI2201 ATI0": { g: 72, l: 0 } });
    expect(generation.days.get("1997-08-01")!.periods["1997-08-01T00:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 3, l: 0 }]);
  });

  it("counts trading periods where a generator used more than it generated as load", () => {
    const generation = calculateMeteredGeneration([row("ATI2201", "atiamuri", "1997-08-01", [-500, -500, 3000])], codes);

    expect(energy(generation).get("1997-08-01")).toEqual({ "ATI2201 ATI0": { g: 3, l: 1 } });
    expect(generation.days.get("1997-08-01")!.periods["1997-08-01T00:00:00"]).toEqual([{ p: "ATI2201 ATI0", g: 0, l: 1 }]);
  });

  it("attributes a generator to the unit listed for each day", () => {
    const generation = calculateMeteredGeneration([
      row("TKA0111", "tekapo_a", "2011-05-31", allDay(1000)),
      row("TKA0111", "tekapo_a", "2011-06-01", allDay(1000)),
    ], codes);

    expect(energy(generation).get("2011-05-31")).toEqual({ "TKA0111 TKA0": { g: 48, l: 0 } });
    expect(energy(generation).get("2011-06-01")).toEqual({ "TKA0111 TKA1": { g: 48, l: 0 } });
  });

  it("leaves out excluded generators without reporting them", () => {
    const generation = calculateMeteredGeneration([row("CYD0331", "teviot", "2020-01-01", allDay(1000))], codes);

    expect(generation.days).toEqual(new Map([["2020-01-01", { energy: {}, periods: {} }]]));
    expect(generation.unlisted).toEqual(new Map());
  });

  it("leaves out and reports generators that aren't listed, unless they had no generation", () => {
    const generation = calculateMeteredGeneration([
      row("ABC0111", "new_plant", "2020-01-01", allDay(1000)),
      row("ABC0111", "new_plant", "2020-01-02", allDay(1000)),
      row("XYZ0111", "idle_plant", "2020-01-01", allDay(0)),
      row("ATI2201", "atiamuri", "2020-01-01", allDay(1000)),
    ], codes);

    expect(energy(generation)).toEqual(new Map([
      ["2020-01-01", { "ATI2201 ATI0": { g: 48, l: 0 } }],
      ["2020-01-02", {}],
    ]));
    expect(generation.unlisted).toEqual(new Map([["ABC0111 new_plant", 96]]));
  });

  it("reads the trading date from either version of its column", () => {
    const { days } = calculateMeteredGeneration([
      row("ATI2201", "atiamuri", "2014-01-01", allDay(1000), { dateColumn: "Trading_date" }),
      row("ATI2201", "atiamuri", "2024-01-01", allDay(1000), { dateColumn: "Trading_Date" }),
    ], codes);

    expect([...days.keys()]).toEqual(["2014-01-01", "2024-01-01"]);
  });
});
