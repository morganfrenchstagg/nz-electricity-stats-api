// Guards against caching a POCP error body or an empty outage list. The 17 day generation window
// normally holds hundreds of outages, so an empty list means POCP is degraded rather than nothing being out.
export function isValidPocpOutageResponse(json: any): boolean {
    return Array.isArray(json?.items) && json.items.length > 0;
}
