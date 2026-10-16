import { describe, expect, it } from "vitest";

import {
  areRecordsUpToDate,
  findDailyRecords,
  findNewRecords,
  formatNewRecordsMessage,
  getGenerationByNode,
  mergeRecords,
} from "./generationRecords";
import { GeneratorDefinition } from "../../clients/generators";
import { HistoricalDispatchRecord } from "../../models/historicalDispatchRecord";
import { rtd } from "../../testing/fixtures";

const HUNTLY_1 = "HLY2201 HLY1";
const HUNTLY_5 = "HLY2201 HLY5";
const ATIAMURI = "ATI2201 ATI0";

const generators: GeneratorDefinition[] = [{
  site: "HLY",
  name: "Huntly",
  units: [
    { name: "Huntly Rankine 1", unitCode: "HLY1", node: HUNTLY_1, capacity: 240, fuel: "Coal/Gas", fuelCode: "CLG" },
    { name: "Huntly Unit 5", unitCode: "HLY5", node: HUNTLY_5, capacity: 403, fuel: "Gas", fuelCode: "GAS" },
  ],
  location: { lat: 0, long: 0 },
  gridZone: "CNI",
  operator: "Genesis Energy",
}];

function record(p: string, g: number): HistoricalDispatchRecord {
  return { p, g: `${g}`, l: "0", c: "100" };
}

describe("getGenerationByNode", () => {
  it("gets each generating unit's generation, ignoring substations", () => {
    const dispatch = [
      rtd(HUNTLY_1, 200.1, 0, 100),
      rtd(HUNTLY_5, 380.2, 0, 100),
      rtd("ALB0331", 0, 20, 100),
    ];

    expect(getGenerationByNode(dispatch)).toEqual(new Map([[HUNTLY_1, 200.1], [HUNTLY_5, 380.2]]));
  });
});

describe("findDailyRecords", () => {
  it("finds each unit's highest generation, and the first interval it reached it", () => {
    const intervals = {
      "2026-10-08T18:00:00": [record(HUNTLY_1, 240), record(HUNTLY_5, 300), record(ATIAMURI, 84)],
      "2026-10-08T18:05:00": [record(HUNTLY_1, 100), record(HUNTLY_5, 403)],
      "2026-10-08T18:10:00": [record(ATIAMURI, 84)],
    };

    expect(findDailyRecords(intervals)).toEqual({
      [HUNTLY_1]: { mw: 240, time: "2026-10-08T18:00:00" },
      [HUNTLY_5]: { mw: 403, time: "2026-10-08T18:05:00" },
      [ATIAMURI]: { mw: 84, time: "2026-10-08T18:00:00" },
    });
  });

  it("ignores substations and units that didn't generate", () => {
    const intervals = { "2026-10-08T18:00:00": [record(ATIAMURI, 0), record("ALB0331", 10)] };

    expect(findDailyRecords(intervals)).toEqual({});
  });
});

describe("mergeRecords", () => {
  it("keeps the higher record for each unit", () => {
    const a = { [ATIAMURI]: { mw: 84, time: "2024-01-01T12:00:00" }, [HUNTLY_5]: { mw: 390, time: "2024-01-01T18:00:00" } };
    const b = { [ATIAMURI]: { mw: 84, time: "2026-01-01T12:00:00" }, [HUNTLY_5]: { mw: 403, time: "2026-01-01T18:00:00" }, [HUNTLY_1]: { mw: 240, time: "2026-01-01T00:00:00" } };

    expect(mergeRecords(a, b)).toEqual({
      [ATIAMURI]: a[ATIAMURI],
      [HUNTLY_5]: b[HUNTLY_5],
      [HUNTLY_1]: b[HUNTLY_1],
    });
  });
});

describe("findNewRecords", () => {
  const time = "2026-10-14T22:00:00";
  const records = {
    [HUNTLY_5]: { mw: 390, time: "2024-03-03T18:30:00" },
    [ATIAMURI]: { mw: 84, time: "2023-01-01T12:00:00" },
  };

  it("alerts for units beating a record from an earlier day", () => {
    const generation = new Map([[HUNTLY_5, 395], [ATIAMURI, 84]]);

    expect(findNewRecords(generation, time, records)).toEqual({
      updated: { [HUNTLY_5]: { mw: 395, time } },
      newRecords: [{ node: HUNTLY_5, record: { mw: 395, time }, previous: records[HUNTLY_5] }],
    });
  });

  it("updates a record set earlier the same day without alerting again", () => {
    const setToday = { [HUNTLY_5]: { mw: 395, time: "2026-10-14T21:55:00" } };

    expect(findNewRecords(new Map([[HUNTLY_5, 398]]), time, setToday)).toEqual({
      updated: { [HUNTLY_5]: { mw: 398, time } },
      newRecords: [],
    });
  });

  it("records a unit's first generation without alerting", () => {
    expect(findNewRecords(new Map([[HUNTLY_1, 40], ["HLY2201 HLY6", 0]]), time, records)).toEqual({
      updated: { [HUNTLY_1]: { mw: 40, time } },
      newRecords: [],
    });
  });
});

describe("areRecordsUpToDate", () => {
  it.each([
    { syncedTo: "20261013", expected: true },
    { syncedTo: "20261007", expected: true },
    { syncedTo: "20261006", expected: false },
    { syncedTo: "20201101", expected: false },
  ])("records up to $syncedTo are up to date: $expected", ({ syncedTo, expected }) => {
    expect(areRecordsUpToDate(syncedTo, "2026-10-14T22:00:00")).toBe(expected);
  });
});

describe("formatNewRecordsMessage", () => {
  it("lists each new record with the record it beat", () => {
    const message = formatNewRecordsMessage([
      { node: HUNTLY_5, record: { mw: 1012.345, time: "2026-10-14T18:00:00" }, previous: { mw: 1000, time: "2024-03-03T18:30:00" } },
      { node: HUNTLY_1, record: { mw: 240.06, time: "2026-10-14T18:00:00" }, previous: { mw: 240, time: "2023-01-01T00:05:00" } },
    ], generators);

    expect(message).toBe(
      "🏆 *Huntly Unit 5* (`HLY2201 HLY5`) is generating *1,012.3 MW*, a new record (previously 1,000 MW at 6:30pm on 3 March 2024)\n" +
      "🏆 *Huntly Rankine 1* (`HLY2201 HLY1`) is generating *240.1 MW*, a new record (previously 240 MW at 12:05am on 1 January 2023)"
    );
  });

  it("uses the node for units that aren't in the generator list", () => {
    const message = formatNewRecordsMessage([
      { node: "XYZ2201 XYZ0", record: { mw: 12, time: "2026-10-14T12:00:00" }, previous: { mw: 10, time: "2026-10-13T12:00:00" } },
    ], generators);

    expect(message).toBe("🏆 `XYZ2201 XYZ0` is generating *12 MW*, a new record (previously 10 MW at 12:00pm on 13 October 2026)");
  });
});
