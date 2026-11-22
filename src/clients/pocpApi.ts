import { env } from "cloudflare:workers";
import { PocpOutage } from "../models/pocpOutage";
import { isValidPocpOutageResponse } from "../services/outageMapping/pocpResponse";

// the outages asked for are the ones going on from this many days ago to this many days ahead
export const OUTAGE_DAYS_BEFORE = 14;
export const OUTAGE_DAYS_AHEAD = 3;

export async function getOutageListFromCache(): Promise<Record<string, PocpOutage[]>> {
    const cachedOutages = await env.dispatch_kv.get("latestOutages");
    if (cachedOutages) {
        return JSON.parse(cachedOutages) as Record<string, PocpOutage[]>;
    }
    return {};
}

export async function getOutageListFromPocp(): Promise<PocpOutage[]> {
    const url = new URL("https://api.transpower.co.nz/v2/so/api/pocp/guest/outages");
    url.searchParams.set("page", "0");
    url.searchParams.set("size", "1000");
    url.searchParams.set("sort", "outageBlock,asc");
    url.searchParams.set("dateOption", "absolute");
    url.searchParams.set("outageAtFrom", new Date(Date.now() - 1000 * 60 * 60 * 24 * OUTAGE_DAYS_BEFORE).toISOString());
    url.searchParams.set("outageAtTo", new Date(Date.now() + 1000 * 60 * 60 * 24 * OUTAGE_DAYS_AHEAD).toISOString());

    let urlString = url.toString();
    urlString += "&planningStatus=CONFIRMED&planningStatus=COMPLETED&category=GENERATION&category=EMBEDDED_GENERATION";

    console.log("Fetching outages from POCP with url", urlString);

    const response = await fetch(urlString);
    if (!response.ok) {
        throw new Error(`POCP outages request failed with status ${response.status}`);
    }

    const json = await response.json() as any;
    if (!isValidPocpOutageResponse(json)) {
        throw new Error("POCP outages response had no outage items");
    }

    return json.items as PocpOutage[];
}