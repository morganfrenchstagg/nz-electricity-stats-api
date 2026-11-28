import { UnitDefinition } from "../../clients/generators";
import { addDays, parseNzTime } from "../../mcp/dates";
import { Timeseries } from "../../models/timeseries";
import { DISPATCH_AGGREGATES_START } from "../dispatchAggregation/dispatchAggregation";

export type Peak = {
  mw: number;
  time: string; // the interval, in NZ time (e.g. 2026-10-14T07:35:00)
};

export type UnitDaySummary = {
  energy: number; // net MWh (generation - load) over the day, or so far today
  peak: Peak; // the interval furthest from 0, so a battery's charging node's is its most negative
  latest: { mw: number; price: number | null };
};

export type StationDaySummary = {
  energy: number; // net MWh (generation - load) of all its units, over the day or so far today
  peak: Peak; // the interval its units' total was highest
};

export type GeneratorDaySummary = {
  // absent until the day has an interval, or when none of the station's units have a column
  station?: StationDaySummary;
  units: Map<string, UnitDaySummary>;
};

// the station's units to give a column on a date: the ones the day's data has, and from when the dispatch data began,
// the ones in service at any time in the day, as the dispatch leaves out units at 0MW. before then the metered data
// combines some units into one (see UnitDefinition.combines), so it's only the ones it has
export function getStationNodes(units: UnitDefinition[], series: string[], date: string): string[] {
  const from = parseNzTime(`${date}T00:00`);
  const to = parseNzTime(`${addDays(date, 1)}T00:00`);
  const isInService = (unit: UnitDefinition) =>
    date >= DISPATCH_AGGREGATES_START &&
    !unit.combines &&
    unit.commissioned !== undefined &&
    Date.parse(unit.commissioned) < to &&
    (unit.decomissioned === undefined || Date.parse(unit.decomissioned) > from);

  return units
    .filter((unit) => series.includes(unit.node) || isInService(unit))
    .map((unit) => unit.node);
}

// a station's day, from its units' columns of the dispatch on the date (see selectNodesOnDate). energy is the mean MW
// over the day's rows times the hours they cover (e.g. to the end of the latest interval so far today), as the
// aggregates have it (see calculateLiveDailyEnergy), so an interval missing from the data isn't counted as 0
export function summariseDay(day: Timeseries, hours: number): GeneratorDaySummary {
  const units = new Map<string, UnitDaySummary>();
  if (day.data.length === 0 || day.series.length === 0) {
    return { units };
  }

  const times: string[] = day.data.map((row) => row[0]);
  const last = day.data.length - 1;
  const energy = (values: number[]) =>
    round((values.reduce((sum, value) => sum + value, 0) / values.length) * hours);

  day.series.forEach((node, index) => {
    const values: number[] = day.data.map((row) => row[index + 1]);
    units.set(node, {
      energy: energy(values),
      peak: findPeak(values, times, (value) => Math.abs(value)),
      latest: { mw: values[last], price: day.pricing[last][index + 1] },
    });
  });

  const totals = day.data.map((row) =>
    round(row.slice(1).reduce((sum: number, value: number) => sum + value, 0)),
  );

  return {
    station: { energy: energy(totals), peak: findPeak(totals, times, (value) => value) },
    units,
  };
}

// the first interval with the highest score
function findPeak(values: number[], times: string[], score: (value: number) => number): Peak {
  let peak = 0;
  for (let i = 1; i < values.length; i++) {
    if (score(values[i]) > score(values[peak])) {
      peak = i;
    }
  }
  return { mw: values[peak], time: times[peak] };
}

// the dispatch is given to 3 decimal places (e.g. 19.125 MW)
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
