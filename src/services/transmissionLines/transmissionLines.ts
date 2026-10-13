import { ONE_DAY_IN_SECONDS } from "../../utilities/utilities";

export const TRANSMISSION_LINES_MAX_AGE_SECONDS = ONE_DAY_IN_SECONDS;

export type TransmissionLinesCacheMetadata = {
    fetchedAt: number;
};

// Guards against caching an ArcGIS error body or a truncated (paginated) result.
export function isValidTransmissionLines(json: any): boolean {
    return json?.type === "FeatureCollection"
        && Array.isArray(json.features)
        && json.features.length > 0
        && json.exceededTransferLimit !== true
        && json.properties?.exceededTransferLimit !== true;
}

export function isStale(metadata: TransmissionLinesCacheMetadata | null, now: number): boolean {
    if (!metadata || typeof metadata.fetchedAt !== "number") {
        return true;
    }
    return now - metadata.fetchedAt >= TRANSMISSION_LINES_MAX_AGE_SECONDS * 1000;
}
