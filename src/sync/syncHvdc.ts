import { env } from "cloudflare:workers";
import { fetchHvdcFromEm6 } from "../clients/em6Api";
import { HvdcTimeseries } from "../models/hvdc";
import { mergeHvdc, splitHvdcByDate, toHvdcTimeseries } from "../services/hvdc/hvdc";

export const HVDC_KEY = "hvdc";

// em6's half hours on each NZ date, kept as em6's window moves past them (e.g. hvdc-em6-20261028)
export const EM6_HVDC_DAY_PREFIX = "hvdc-em6-";

// stores the HVDC's flows and limits over the last day from em6, which adds a half hour every half hour, and adds them to
// each day's (see syncHvdcHistory). it runs with the dispatch sync, so it logs rather than throws when em6 is
// unavailable, keeping the last day it got
export async function syncHvdc() {
  console.log("Syncing HVDC");
  try {
    const timeseries = toHvdcTimeseries(await fetchHvdcFromEm6());
    await env.dispatch.put(HVDC_KEY, JSON.stringify(timeseries));
    await saveEm6Days(timeseries);
  } catch (e) {
    console.error("Failed to sync HVDC from em6, keeping the cached HVDC", e);
  }
}

async function saveEm6Days(timeseries: HvdcTimeseries) {
  await Promise.all([...splitHvdcByDate(timeseries)].map(async ([date, day]) => {
    const key = EM6_HVDC_DAY_PREFIX + date.replace(/-/g, "");
    const stored = await (await env.dispatch.get(key))?.text();
    const merged = JSON.stringify(mergeHvdc(stored ? JSON.parse(stored) as HvdcTimeseries : null, day));

    // em6 only adds a half hour every half hour, so most syncs don't change anything
    if (merged !== stored) {
      await env.dispatch.put(key, merged);
    }
  }));
}
