import { RealTimeDispatch } from "../../models/realTimeDispatch";
import { Timeseries } from "../../models/timeseries";
import { getNZDateTime } from "../nzDateTime";

// the recent endpoint's last few days of dispatch, which the HVDC returned with it covers too (see toRecentHvdc)
export const TIMESERIES_DAYS = 3;

const MAX_DATA_POINTS = (60 / 5) * 24 * TIMESERIES_DAYS;

export function generateTimeseries(
  existingTimeseries: Timeseries,
  rtdData: RealTimeDispatch[],
): Timeseries {
  if (
    rtdData.length === 0 ||
    existingTimeseries.data.some((row: any[]) => row[0] === rtdData[0].FiveMinuteIntervalDatetime)
  ) {
    return existingTimeseries;
  }
  const timestamp = rtdData[0].FiveMinuteIntervalDatetime;

  // new nodes go after the existing ones, so the existing rows' columns never move, even if EMI lists the nodes in a
  // different order. the rows from before a node appeared only need 0s adding for it
  const series = [...existingTimeseries.series];
  const columns = new Map(series.map((node, index) => [node, index + 1]));
  for (const item of rtdData) {
    if (!columns.has(item.PointOfConnectionCode)) {
      series.push(item.PointOfConnectionCode);
      columns.set(item.PointOfConnectionCode, series.length);
    }
  }

  // nodes missing from this interval (e.g. ones that have been removed) are 0
  const row: any[] = [timestamp, ...series.map(() => 0)];
  const pricingRow: any[] = [timestamp, ...series.map(() => 0)];
  for (const item of rtdData) {
    const column = columns.get(item.PointOfConnectionCode)!;
    row[column] = item.SPDGenerationMegawatt - item.SPDLoadMegawatt;
    pricingRow[column] = item.DollarsPerMegawattHour;
  }

  // the last few days, including the new row
  const start = Math.max(existingTimeseries.data.length - (MAX_DATA_POINTS - 1), 0);
  const width = series.length + 1;
  const data = existingTimeseries.data
    .slice(start)
    .map((existingRow: any[]) => padRow(existingRow, width));
  // timeseries from before prices were added don't have them, so they're 0
  const pricing = existingTimeseries.data
    .slice(start)
    .map((existingRow: any[], index: number) =>
      padRow(existingTimeseries.pricing?.[start + index] ?? [existingRow[0]], width),
    );

  data.push(row);
  pricing.push(pricingRow);

  return {
    series,
    data,
    pricing,
  };
}

// adds 0s for the nodes added since the row, which weren't dispatched then. rows that are already full width are
// returned as they are, so a sync without new nodes doesn't copy them
function padRow(row: any[], width: number): any[] {
  return row.length < width ? [...row, ...new Array(width - row.length).fill(0)] : row;
}

// keeps only the rows after `since`. timestamps are all NZ times in the same format (e.g. 2026-10-14T22:00:00), so
// they can be compared as strings
export function filterTimeseriesSince(timeseries: Timeseries, since: string): Timeseries {
  return {
    series: timeseries.series,
    data: timeseries.data.filter((row: any[]) => row[0] > since),
    pricing: timeseries.pricing.filter((row: any[]) => row[0] > since),
  };
}

// the given nodes' columns, in the order they're given, and only the rows on an NZ date (e.g. 2026-10-14). a node the
// timeseries has no column for is 0, as the dispatch leaves out nodes at 0MW, with no price
export function selectNodesOnDate(
  timeseries: Timeseries,
  nodes: string[],
  date: string,
): Timeseries {
  const columns = nodes.map((node) => timeseries.series.indexOf(node) + 1);
  const select = (rows: any[][], missing: number | null) =>
    rows
      .filter((row) => row[0].startsWith(date))
      .map((row) => [row[0], ...columns.map((column) => (column > 0 ? row[column] : missing))]);

  return {
    series: nodes,
    data: select(timeseries.data, 0),
    pricing: select(timeseries.pricing, null),
  };
}

const DEFAULT_MAX_AGE = 30;

// the seconds until the interval after the timeseries' latest one is due (a minute after it ends), or a short while if
// it's already overdue
export function calculateMaxAgeHeader(timeseries: Timeseries): number {
  const latestTimestamp = timeseries.data[timeseries.data.length - 1][0];

  const latestDate = new Date(latestTimestamp);
  const nextDate = new Date(latestDate.setTime(latestDate.getTime() + 6 * 1000 * 60)); // 6 minutes later (5 min + 1)
  const now = getNZDateTime();

  const cachableTimeInSeconds = (nextDate.getTime() - now.getTime()) / 1000;
  return cachableTimeInSeconds > 0 ? cachableTimeInSeconds : DEFAULT_MAX_AGE;
}
