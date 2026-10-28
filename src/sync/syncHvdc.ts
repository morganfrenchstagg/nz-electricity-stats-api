import { env } from "cloudflare:workers";
import { fetchHvdcFromEm6 } from "../clients/em6Api";
import { toHvdcTimeseries } from "../services/hvdc/hvdc";

export const HVDC_KEY = "hvdc";

// stores the HVDC's flows and limits over the last day from em6, which adds a half hour every half hour. it runs with
// the dispatch sync, so it logs rather than throws when em6 is unavailable, keeping the last day it got
export async function syncHvdc() {
  console.log("Syncing HVDC");
  try {
    const response = await fetchHvdcFromEm6();
    await env.dispatch.put(HVDC_KEY, JSON.stringify(toHvdcTimeseries(response)));
  } catch (e) {
    console.error("Failed to sync HVDC from em6, keeping the cached HVDC", e);
  }
}
