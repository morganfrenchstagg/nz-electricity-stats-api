import { PocpOutage } from "../models/pocpOutage";

export async function getOutageListFromPocp(): Promise<PocpOutage[]> {
    const url = new URL("https://api.transpower.co.nz/v2/so/api/pocp/guest/outages");
    url.searchParams.set("page", "0");
    url.searchParams.set("size", "1000");
    url.searchParams.set("sort", "outageBlock,asc");
    url.searchParams.set("dateOption", "absolute");
    url.searchParams.set("outageAtFrom", new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString());
    url.searchParams.set("outageAtTo", new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString());

    let urlString = url.toString();
    urlString += "&planningStatus=CONFIRMED&planningStatus=COMPLETED&category=GENERATION&category=EMBEDDED_GENERATION";

    console.log("Fetching outages from POCP with url", urlString);

    const response = await fetch(urlString);

    const json = await response.json() as any;

    return json.items as PocpOutage[];
}