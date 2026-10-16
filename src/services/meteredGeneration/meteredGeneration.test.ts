import { describe, expect, it } from "vitest";

import { calculateMeteredDailyEnergy, getMeteredCode, MeteredGenerationCode } from "./meteredGeneration";

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

describe("getMeteredCode", () => {
  it("is the point of connection and the lowercased generator code", () => {
    expect(getMeteredCode(row("THI2201", "Te_Mihi", "2014-01-01", []))).toBe("THI2201 te_mihi");
  });
});

describe("calculateMeteredDailyEnergy", () => {
  it("totals each day's trading periods (kWh) by node in MWh", () => {
    const { days, unlisted } = calculateMeteredDailyEnergy([
      row("ATI2201", "atiamuri", "1997-08-01", allDay(25000)),
      row("ATI2201", "atiamuri", "1997-08-02", [10000, 20000]),
    ], codes);

    expect(days).toEqual(new Map([
      ["1997-08-01", { "ATI2201 ATI0": { g: 1200, l: 0 } }],
      ["1997-08-02", { "ATI2201 ATI0": { g: 30, l: 0 } }],
    ]));
    expect(unlisted).toEqual(new Map());
  });

  it("includes the extra trading periods on the day daylight saving ends", () => {
    const { days } = calculateMeteredDailyEnergy([row("ATI2201", "atiamuri", "2020-04-05", Array(50).fill(1000))], codes);

    expect(days.get("2020-04-05")).toEqual({ "ATI2201 ATI0": { g: 50, l: 0 } });
  });

  it("adds together a generator's rows under different network codes", () => {
    const { days } = calculateMeteredDailyEnergy([
      row("ATI2201", "atiamuri", "1997-08-01", allDay(1000), { network: "MRPL" }),
      row("ATI2201", "Atiamuri", "1997-08-01", allDay(500), { network: "WAIK" }),
    ], codes);

    expect(days.get("1997-08-01")).toEqual({ "ATI2201 ATI0": { g: 72, l: 0 } });
  });

  it("counts trading periods where a generator used more than it generated as load", () => {
    const { days } = calculateMeteredDailyEnergy([row("ATI2201", "atiamuri", "1997-08-01", [-500, -500, 3000])], codes);

    expect(days.get("1997-08-01")).toEqual({ "ATI2201 ATI0": { g: 3, l: 1 } });
  });

  it("attributes a generator to the unit listed for each day", () => {
    const { days } = calculateMeteredDailyEnergy([
      row("TKA0111", "tekapo_a", "2011-05-31", allDay(1000)),
      row("TKA0111", "tekapo_a", "2011-06-01", allDay(1000)),
    ], codes);

    expect(days.get("2011-05-31")).toEqual({ "TKA0111 TKA0": { g: 48, l: 0 } });
    expect(days.get("2011-06-01")).toEqual({ "TKA0111 TKA1": { g: 48, l: 0 } });
  });

  it("leaves out excluded generators without reporting them", () => {
    const { days, unlisted } = calculateMeteredDailyEnergy([row("CYD0331", "teviot", "2020-01-01", allDay(1000))], codes);

    expect(days).toEqual(new Map([["2020-01-01", {}]]));
    expect(unlisted).toEqual(new Map());
  });

  it("leaves out and reports generators that aren't listed, unless they had no generation", () => {
    const { days, unlisted } = calculateMeteredDailyEnergy([
      row("ABC0111", "new_plant", "2020-01-01", allDay(1000)),
      row("ABC0111", "new_plant", "2020-01-02", allDay(1000)),
      row("XYZ0111", "idle_plant", "2020-01-01", allDay(0)),
      row("ATI2201", "atiamuri", "2020-01-01", allDay(1000)),
    ], codes);

    expect(days).toEqual(new Map([
      ["2020-01-01", { "ATI2201 ATI0": { g: 48, l: 0 } }],
      ["2020-01-02", {}],
    ]));
    expect(unlisted).toEqual(new Map([["ABC0111 new_plant", 96]]));
  });

  it("reads the trading date from either version of its column", () => {
    const { days } = calculateMeteredDailyEnergy([
      row("ATI2201", "atiamuri", "2014-01-01", allDay(1000), { dateColumn: "Trading_date" }),
      row("ATI2201", "atiamuri", "2024-01-01", allDay(1000), { dateColumn: "Trading_Date" }),
    ], codes);

    expect([...days.keys()]).toEqual(["2014-01-01", "2024-01-01"]);
  });
});
