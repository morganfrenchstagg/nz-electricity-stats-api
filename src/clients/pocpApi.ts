import { env } from "cloudflare:workers";
import { PocpOutage } from "../models/pocpOutage";
import { isValidPocpOutageResponse } from "../services/outageMapping/pocpResponse";

// the outages asked for are the ones going on from this many days ago to this many days ahead
export const OUTAGE_DAYS_BEFORE = 14;
export const OUTAGE_DAYS_AHEAD = 3;

const ONE_DAY_IN_MS = 1000 * 60 * 60 * 24;

export async function getOutageListFromCache(): Promise<Record<string, PocpOutage[]>> {
  const cachedOutages = await env.dispatch_kv.get("latestOutages");
  if (cachedOutages) {
    return JSON.parse(cachedOutages) as Record<string, PocpOutage[]>;
  }
  return {};
}

export async function getOutageListFromPocp(): Promise<PocpOutage[]> {
  const json = await fetchPocpOutages(
    new Date(Date.now() - ONE_DAY_IN_MS * OUTAGE_DAYS_BEFORE),
    new Date(Date.now() + ONE_DAY_IN_MS * OUTAGE_DAYS_AHEAD),
  );
  if (!isValidPocpOutageResponse(json)) {
    throw new Error("POCP outages response had no outage items");
  }
  return json.items as PocpOutage[];
}

// the outages going on at any time from `from` to `to`, which can be years ago, as POCP keeps its history. POCP widens
// the window by up to a day or so, so some returned end before it or start after it. unlike the rolling window above,
// a short window can have no outages at all
export async function getOutageListFromPocpBetween(from: Date, to: Date): Promise<PocpOutage[]> {
  const json = await fetchPocpOutages(from, to);
  if (!Array.isArray(json?.items)) {
    throw new Error("POCP outages response had no outage list");
  }
  return json.items as PocpOutage[];
}

async function fetchPocpOutages(from: Date, to: Date): Promise<any> {
  const url = new URL("https://api.transpower.co.nz/v2/so/api/pocp/guest/outages");
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "1000");
  url.searchParams.set("sort", "outageBlock,asc");
  url.searchParams.set("dateOption", "absolute");
  url.searchParams.set("outageAtFrom", from.toISOString());
  url.searchParams.set("outageAtTo", to.toISOString());

  let urlString = url.toString();
  urlString +=
    "&planningStatus=CONFIRMED&planningStatus=COMPLETED&category=GENERATION&category=EMBEDDED_GENERATION";

  console.log("Fetching outages from POCP with url", urlString);

  const response = await fetch(urlString);
  if (!response.ok) {
    throw new Error(`POCP outages request failed with status ${response.status}`);
  }

  return response.json();
}
