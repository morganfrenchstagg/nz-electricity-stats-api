import { env } from "cloudflare:workers";
import { fetchHvdcFromEm6 } from "../clients/em6Api";
import { HvdcTimeseries } from "../models/hvdc";
import { getRecentHvdcDates, mergeHvdc, splitHvdcByDate, toHvdcTimeseries, toRecentHvdc } from "../services/hvdc/hvdc";

export const HVDC_KEY = "hvdc";

// em6's half hours on each NZ date, kept as em6's window moves past them (e.g. hvdc-em6-20261028)
export const EM6_HVDC_DAY_PREFIX = "hvdc-em6-";

// stores the HVDC's flows and limits from em6, which has the last day and adds a half hour every half hour, adding them
// to each day's (see syncHvdcHistory), and keeps the same last few days as the dispatch from those for the recent
// endpoint. it runs with the dispatch sync, so it logs rather than throws when em6 is unavailable, keeping the HVDC it got
export async function syncHvdc() {
  console.log("Syncing HVDC");
  try {
    const timeseries = toHvdcTimeseries(await fetchHvdcFromEm6());
    const { latestDays, changed } = await saveEm6Days(timeseries);

    // the recent HVDC is made from em6's days alone, so it's only rewritten when em6 has added to them
    if (changed) {
      await saveRecentHvdc(latestDays);
    } else {
      console.log("No new HVDC from em6");
    }
  } catch (e) {
    console.error("Failed to sync HVDC from em6, keeping the cached HVDC", e);
  }
}

// each of em6's dates with its latest half hours added, by date (e.g. 2026-10-28), and whether any of them changed
async function saveEm6Days(timeseries: HvdcTimeseries): Promise<{ latestDays: Map<string, HvdcTimeseries>; changed: boolean }> {
  let changed = false;
  const latestDays = new Map(await Promise.all([...splitHvdcByDate(timeseries)].map(async ([date, day]) => {
    const stored = await (await env.dispatch.get(getEm6DayKey(date)))?.text();
    const merged = mergeHvdc(stored ? JSON.parse(stored) as HvdcTimeseries : null, day);
    const json = JSON.stringify(merged);

    // em6 only adds a half hour every half hour, so most syncs don't change anything
    if (json !== stored) {
      await env.dispatch.put(getEm6DayKey(date), json);
      changed = true;
    }
    return [date, merged] as const;
  })));
  return { latestDays, changed };
}

// from each day's half hours, as em6 only has the last day
async function saveRecentHvdc(latestDays: Map<string, HvdcTimeseries>) {
  const dates = getRecentHvdcDates([...latestDays.keys()].at(-1)!);
  const days = await Promise.all(dates.map(async date =>
    latestDays.get(date) ?? await (await env.dispatch.get(getEm6DayKey(date)))?.json() as HvdcTimeseries | undefined));
  await env.dispatch.put(HVDC_KEY, JSON.stringify(toRecentHvdc(days.filter(day => day !== undefined))));
}

// e.g. 2026-10-28 => hvdc-em6-20261028
function getEm6DayKey(date: string): string {
  return EM6_HVDC_DAY_PREFIX + date.replace(/-/g, "");
}
