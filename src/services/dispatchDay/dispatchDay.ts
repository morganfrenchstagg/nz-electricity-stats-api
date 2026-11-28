import { env } from "cloudflare:workers";
import { HistoricalDispatchRecord } from "../../models/historicalDispatchRecord";
import { MeteredGenerationRecord } from "../../models/meteredGenerationRecord";
import { Timeseries } from "../../models/timeseries";
import { DISPATCH_AGGREGATES_START } from "../dispatchAggregation/dispatchAggregation";
import { METERED_DAY_PREFIX } from "../meteredGeneration/meteredGeneration";

// a day's dispatch by interval from EMI's daily files, or its metered generation and load by trading period for the
// days the aggregates take from metered data (including the first, partial, day of dispatch files). each falls back to
// the other, e.g. while the metered data is still being backfilled. null when neither has the day, e.g. as EMI only
// publishes a day's file the day after. date is in the format 20261014
export async function readDispatchDay(date: string): Promise<Timeseries | null> {
  const keys =
    date < DISPATCH_AGGREGATES_START.replace(/-/g, "")
      ? [METERED_DAY_PREFIX + date, `dispatch-${date}`]
      : [`dispatch-${date}`, METERED_DAY_PREFIX + date];
  const file = (await env.dispatch.get(keys[0])) ?? (await env.dispatch.get(keys[1]));
  if (!file) {
    return null;
  }

  const intervals = (await file.json()) as Record<
    string,
    (HistoricalDispatchRecord | MeteredGenerationRecord)[]
  >;
  return toDayTimeseries(intervals);
}

// the daily files leave out most nodes while they're at 0MW generation and load, so a node missing from an interval
// is 0 rather than unknown. intervals missing from the file entirely are still left out. metered data has no prices,
// so its prices are all null
function toDayTimeseries(
  intervals: Record<string, (HistoricalDispatchRecord | MeteredGenerationRecord)[]>,
): Timeseries {
  const series = [
    ...new Set(Object.values(intervals).flatMap((records) => records.map((record) => record.p))),
  ];
  const columns = new Map(series.map((node, index) => [node, index + 1]));

  const data = [] as (string | number)[][];
  const pricing = [] as (string | number | null)[][];

  for (const timestamp in intervals) {
    const dataRow: (string | number)[] = [timestamp, ...series.map(() => 0)];
    const priceRow: (string | number | null)[] = [timestamp, ...series.map(() => null)];

    for (const record of intervals[timestamp]) {
      dataRow[columns.get(record.p)!] = +record.g - +record.l;
      priceRow[columns.get(record.p)!] = "c" in record ? +record.c : null;
    }

    data.push(dataRow);
    pricing.push(priceRow);
  }

  return { series, data, pricing };
}
