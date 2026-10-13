import { env } from "cloudflare:workers";
import { isStale, isValidTransmissionLines, TransmissionLinesCacheMetadata } from "../services/transmissionLines/transmissionLines";

// Same query the nz-electricity-map frontend uses for its transmission line layer.
const TRANSMISSION_LINES_URL = "https://services3.arcgis.com/AkUq3zcWf7TVqyR9/arcgis/rest/services/TransmissionLines/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson";
const KV_KEY = "transmissionLines";

export async function fetchTransmissionLinesFromArcgis(): Promise<string> {
    const response = await fetch(TRANSMISSION_LINES_URL);
    if (!response.ok) {
        throw new Error(`ArcGIS transmission lines request failed with status ${response.status}`);
    }

    const body = await response.text();
    if (!isValidTransmissionLines(JSON.parse(body))) {
        throw new Error("ArcGIS transmission lines response was not a complete FeatureCollection");
    }

    return body;
}

export async function refreshTransmissionLinesCache(): Promise<string> {
    const body = await fetchTransmissionLinesFromArcgis();
    const metadata: TransmissionLinesCacheMetadata = { fetchedAt: Date.now() };
    await env.dispatch_kv.put(KV_KEY, body, { metadata });
    return body;
}

/**
 * Returns the cached GeoJSON, refreshing from ArcGIS when it is over a day old.
 * A stale copy is served immediately and refreshed in the background, so
 * ArcGIS is only on the request path when nothing has been cached yet.
 */
export async function getTransmissionLines(waitUntil: (promise: Promise<unknown>) => void): Promise<string> {
    const cached = await env.dispatch_kv.getWithMetadata<TransmissionLinesCacheMetadata>(KV_KEY);

    if (cached.value === null) {
        return await refreshTransmissionLinesCache();
    }

    if (isStale(cached.metadata, Date.now())) {
        waitUntil(refreshTransmissionLinesCache().catch((e) => {
            console.error("Failed to refresh transmission lines, serving stale copy", e);
        }));
    }

    return cached.value;
}
