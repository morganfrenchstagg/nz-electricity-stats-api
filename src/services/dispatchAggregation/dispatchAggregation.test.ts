import { it, describe, expect } from "vitest";

import {
  calculateDailyEnergy,
  calculateLiveDailyEnergy,
  getDatesBetween,
  getIsoWeek,
  getMonthBounds,
  getTradingPeriodStarts,
  hoursInNzDay,
  sumDataPoints,
  toTimeseries,
  upsertDataPoint,
} from "./dispatchAggregation";
import { HistoricalDispatchRecord } from "../../models/historicalDispatchRecord";
import { DispatchAggregate } from "../../models/dispatchAggregate";
import { Timeseries } from "../../models/timeseries";

function record(p: string, g: number, l: number): HistoricalDispatchRecord {
  return { p, g: `${g}`, l: `${l}`, c: "100" };
}

// builds a full day of 5 minute intervals (288 normally)
function fullDay(date: string, records: (index: number) => HistoricalDispatchRecord[]): Record<string, HistoricalDispatchRecord[]> {
  const out = {} as Record<string, HistoricalDispatchRecord[]>;
  for (let i = 0; i < 288; i++) {
    const hours = String(Math.floor(i / 12)).padStart(2, "0");
    const minutes = String((i % 12) * 5).padStart(2, "0");
    out[`${date}T${hours}:${minutes}:00`] = records(i);
  }
  return out;
}

describe("calculateDailyEnergy", () => {
  it("full day of constant output gives MW x 24", () => {
    const intervals = fullDay("2026-10-08", () => [
      record("ARA2201 ARA0", 72, 0),
      record("ABY0111", 0, 2.5),
    ]);

    expect(calculateDailyEnergy("2026-10-08", intervals)).toEqual({
      from: "2026-10-08",
      to: "2026-10-08",
      nodes: {
        "ARA2201 ARA0": { g: 1728, l: 0 },
        "ABY0111": { g: 0, l: 60 },
      },
    });
  });

  it("missing intervals are filled by averaging the intervals that are present", () => {
    const intervals = fullDay("2026-10-08", () => [record("ARA2201 ARA0", 72, 0)]);
    // drop the first half of the day, but output during the second half was 100MW
    const keys = Object.keys(intervals);
    keys.slice(0, 144).forEach(key => delete intervals[key]);
    keys.slice(144).forEach(key => intervals[key] = [record("ARA2201 ARA0", 100, 0)]);

    expect(calculateDailyEnergy("2026-10-08", intervals).nodes).toEqual({
      "ARA2201 ARA0": { g: 2400, l: 0 },
    });
  });

  it("a node missing from an interval that other nodes are in counts as zero", () => {
    // solar farm only reported during the middle 12 hours
    const intervals = fullDay("2026-10-08", (i) => [
      record("ABY0111", 0, 1),
      ...(i >= 72 && i < 216 ? [record("KOE1101 KSF0", 20, 0)] : []),
    ]);

    expect(calculateDailyEnergy("2026-10-08", intervals).nodes["KOE1101 KSF0"]).toEqual({ g: 240, l: 0 });
  });

  it("intervals with multiple runs are weighted by the number of runs", () => {
    const intervals = {
      "2026-10-08T05:05:00": [record("A", 10, 0)],
      "2026-10-08T05:10:00": [record("A", 20, 0), record("A", 30, 0)],
    };

    // (10 + 20 + 30) / 3 samples * 24 hours
    expect(calculateDailyEnergy("2026-10-08", intervals).nodes["A"]).toEqual({ g: 480, l: 0 });
  });

  it("uses 25 hours on the day daylight saving ends", () => {
    const intervals = fullDay("2026-04-05", () => [record("A", 10, 0)]);
    // the repeated hour shares timestamps with the first 02:00 hour
    for (let minutes = 0; minutes < 60; minutes += 5) {
      intervals[`2026-04-05T02:${String(minutes).padStart(2, "0")}:00`].push(record("A", 10, 0));
    }

    expect(calculateDailyEnergy("2026-04-05", intervals).nodes["A"]).toEqual({ g: 250, l: 0 });
  });

  it("empty file gives no nodes", () => {
    expect(calculateDailyEnergy("2026-10-08", {}).nodes).toEqual({});
  });
});

describe("calculateLiveDailyEnergy", () => {
  // a live dispatch timeseries, with each node's net MW at each interval
  function live(series: string[], data: (string | number)[][]): Timeseries {
    return { series, data, pricing: [] };
  }

  const intervalTimes = (date: string) => Object.keys(fullDay(date, () => []));

  it("counts complete days over the whole day, and the last day up to the end of its latest interval", () => {
    const times = [...intervalTimes("2026-10-23"), ...intervalTimes("2026-10-24").slice(0, 144)];
    const timeseries = live(["ARA2201 ARA0", "ABY0111"], times.map(time => [time, 72, -2.5]));

    expect(calculateLiveDailyEnergy(timeseries)).toEqual([
      {
        from: "2026-10-23",
        to: "2026-10-23",
        nodes: {
          "ARA2201 ARA0": { g: 1728, l: 0 },
          "ABY0111": { g: 0, l: 60 },
        },
      },
      {
        from: "2026-10-24",
        to: "2026-10-24",
        nodes: {
          "ARA2201 ARA0": { g: 864, l: 0 },
          "ABY0111": { g: 0, l: 30 },
        },
      },
    ]);
  });

  it("missing intervals are filled by averaging the intervals that are present", () => {
    const timeseries = live(["ARA2201 ARA0"], [
      // only the first half of the day, at 100MW
      ...intervalTimes("2026-10-23").slice(0, 144).map(time => [time, 100]),
      // the first 6 hours, with only the first and last intervals
      ["2026-10-24T00:00:00", 10],
      ["2026-10-24T05:55:00", 20],
    ]);

    expect(calculateLiveDailyEnergy(timeseries).map(day => day.nodes["ARA2201 ARA0"])).toEqual([
      { g: 2400, l: 0 },
      { g: 90, l: 0 },
    ]);
  });

  it("skips the first day unless it starts at midnight, as the timeseries only keeps the last few days", () => {
    const rows = [["2026-10-23T13:50:00", 50], ["2026-10-24T00:00:00", 50]];

    expect(calculateLiveDailyEnergy(live(["A"], rows)).map(day => day.from)).toEqual(["2026-10-24"]);
    expect(calculateLiveDailyEnergy(live(["A"], [["2026-10-23T00:00:00", 50], ...rows])).map(day => day.from)).toEqual(["2026-10-23", "2026-10-24"]);
  });

  it("counts net MW as generation when positive and load when negative, and leaves out nodes at 0MW all day", () => {
    const timeseries = live(["BATTERY", "IDLE"], [
      ["2026-10-24T00:00:00", 10, 0],
      ["2026-10-24T05:55:00", -10, 0],
    ]);

    expect(calculateLiveDailyEnergy(timeseries)[0].nodes).toEqual({
      "BATTERY": { g: 30, l: 30 },
    });
  });

  it("counts the last day's hours across the daylight saving changes", () => {
    const lastDay = (date: string, until: string) => calculateLiveDailyEnergy(live(["A"], [[`${date}T00:00:00`, 12], [`${date}T${until}:00`, 12]]))[0].nodes["A"].g;

    // daylight saving starts at 02:00, so 12:00 is 11 hours into the day
    expect(lastDay("2026-09-27", "01:55")).toBe(24);
    expect(lastDay("2026-09-27", "11:55")).toBe(132);
    // daylight saving ends at 03:00, so 12:00 is 13 hours into the day
    expect(lastDay("2026-04-05", "01:55")).toBe(24);
    expect(lastDay("2026-04-05", "11:55")).toBe(156);
  });

  it("returns nothing before anything has been synced", () => {
    expect(calculateLiveDailyEnergy(live([], []))).toEqual([]);
  });
});

describe("getTradingPeriodStarts", () => {
  it("starts a period every half hour from midnight", () => {
    const starts = getTradingPeriodStarts("2026-10-08", 48);

    expect(starts.slice(0, 3)).toEqual(["2026-10-08T00:00:00", "2026-10-08T00:30:00", "2026-10-08T01:00:00"]);
    expect(starts[47]).toBe("2026-10-08T23:30:00");
  });

  it("skips the hour daylight saving starts", () => {
    const starts = getTradingPeriodStarts("2026-09-27", 46);

    expect(starts.slice(3, 5)).toEqual(["2026-09-27T01:30:00", "2026-09-27T03:00:00"]);
    expect(starts[45]).toBe("2026-09-27T23:30:00");
  });

  it("repeats the hour daylight saving ends", () => {
    const starts = getTradingPeriodStarts("2026-04-05", 50);

    expect(starts.slice(4, 8)).toEqual(["2026-04-05T02:00:00", "2026-04-05T02:30:00", "2026-04-05T02:00:00", "2026-04-05T02:30:00"]);
    expect(starts[49]).toBe("2026-04-05T23:30:00");
  });

  it("follows the daylight saving rules of the time", () => {
    // daylight saving ended in March until 2007, and NZ didn't have it at all before 1974
    expect(getTradingPeriodStarts("2006-03-19", 50)[6]).toBe("2006-03-19T02:00:00");
    expect(getTradingPeriodStarts("1973-03-04", 48)[47]).toBe("1973-03-04T23:30:00");
  });
});

describe("hoursInNzDay", () => {
  it("normal day has 24 hours", () => {
    expect(hoursInNzDay("2026-10-08")).toBe(24);
    expect(hoursInNzDay("2026-06-15")).toBe(24);
  });

  it("day daylight saving starts has 23 hours", () => {
    expect(hoursInNzDay("2026-09-27")).toBe(23);
    expect(hoursInNzDay("2025-09-28")).toBe(23);
  });

  it("day daylight saving ends has 25 hours", () => {
    expect(hoursInNzDay("2026-04-05")).toBe(25);
    expect(hoursInNzDay("2025-04-06")).toBe(25);
  });

  it("days either side of daylight saving have 24 hours", () => {
    expect(hoursInNzDay("2026-09-26")).toBe(24);
    expect(hoursInNzDay("2026-09-28")).toBe(24);
    expect(hoursInNzDay("2026-04-04")).toBe(24);
    expect(hoursInNzDay("2026-04-06")).toBe(24);
  });
});

describe("getIsoWeek", () => {
  it("mid year", () => {
    expect(getIsoWeek("2026-10-08")).toEqual({ year: "2026", from: "2026-10-05", to: "2026-10-11" });
  });

  it("monday and sunday belong to the same week", () => {
    expect(getIsoWeek("2026-10-05").from).toBe("2026-10-05");
    expect(getIsoWeek("2026-10-11").from).toBe("2026-10-05");
    expect(getIsoWeek("2026-10-12").from).toBe("2026-10-12");
  });

  it("late december can belong to the following year", () => {
    expect(getIsoWeek("2024-12-30")).toEqual({ year: "2025", from: "2024-12-30", to: "2025-01-05" });
  });

  it("early january can belong to the previous year", () => {
    expect(getIsoWeek("2027-01-01")).toEqual({ year: "2026", from: "2026-12-28", to: "2027-01-03" });
  });
});

describe("getMonthBounds", () => {
  it("returns first and last day of the month", () => {
    expect(getMonthBounds("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(getMonthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("getDatesBetween", () => {
  it("is inclusive and crosses month boundaries", () => {
    expect(getDatesBetween("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

describe("sumDataPoints", () => {
  it("sums each node", () => {
    const day1 = { from: "2026-10-05", to: "2026-10-05", nodes: { A: { g: 0.1, l: 1 }, B: { g: 5, l: 0 } } };
    const day2 = { from: "2026-10-06", to: "2026-10-06", nodes: { A: { g: 0.2, l: 2 }, C: { g: 1, l: 1 } } };

    expect(sumDataPoints("2026-10-05", "2026-10-11", [day1, day2])).toEqual({
      from: "2026-10-05",
      to: "2026-10-11",
      nodes: {
        A: { g: 0.3, l: 3 },
        B: { g: 5, l: 0 },
        C: { g: 1, l: 1 },
      },
    });
  });
});

describe("upsertDataPoint", () => {
  const point = (date: string, g: number) => ({ from: date, to: date, nodes: { A: { g, l: 0 } } });

  it("replaces an existing data point for the same period and keeps them in order", () => {
    const aggregate = { data: [point("2026-10-01", 1), point("2026-10-03", 3)] };

    const updated = upsertDataPoint(upsertDataPoint(aggregate, point("2026-10-02", 2)), point("2026-10-01", 10));

    expect(updated.data.map(item => [item.from, item.nodes.A.g])).toEqual([
      ["2026-10-01", 10],
      ["2026-10-02", 2],
      ["2026-10-03", 3],
    ]);
  });
});

describe("toTimeseries", () => {
  const aggregate: DispatchAggregate = {
    data: [
      { from: "2026-10-01", to: "2026-10-01", nodes: { "HLY2201 HLY6": { g: 410.154, l: 0 }, "ABY0111": { g: 0, l: 50.5 }, "HLY2201": { g: 1.1, l: 3.3 } } },
      { from: "2026-10-02", to: "2026-10-02", nodes: { "HLY2201 HLY6": { g: 555.475, l: 0 }, "KOE1101 KSF0": { g: 217.232, l: 0 } } },
    ],
  };

  it("has a sorted series of nodes, and a row of net MWh per period with 0 for nodes with no data", () => {
    expect(toTimeseries(aggregate)).toEqual({
      series: ["ABY0111", "HLY2201", "HLY2201 HLY6", "KOE1101 KSF0"],
      data: [
        ["2026-10-01", -50.5, -2.2, 410.154, 0],
        ["2026-10-02", 0, 0, 555.475, 217.232],
      ],
    });
  });

  it("filters the series by node prefix", () => {
    expect(toTimeseries(aggregate, ["HLY2201", "KOE"])).toEqual({
      series: ["HLY2201", "HLY2201 HLY6", "KOE1101 KSF0"],
      data: [
        ["2026-10-01", -2.2, 410.154, 0],
        ["2026-10-02", 0, 555.475, 217.232],
      ],
    });
  });

  it("empty aggregate", () => {
    expect(toTimeseries({ data: [] })).toEqual({ series: [], data: [] });
  });
});
