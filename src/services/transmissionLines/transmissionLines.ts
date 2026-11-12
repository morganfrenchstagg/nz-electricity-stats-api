import { ONE_DAY_IN_SECONDS } from "../../utilities/utilities";

export const TRANSMISSION_LINES_MAX_AGE_SECONDS = ONE_DAY_IN_SECONDS;

// Guards against passing on (and so caching) an ArcGIS error body or a truncated (paginated) result.
export function isValidTransmissionLines(json: any): boolean {
    return json?.type === "FeatureCollection"
        && Array.isArray(json.features)
        && json.features.length > 0
        && json.exceededTransferLimit !== true
        && json.properties?.exceededTransferLimit !== true;
}
