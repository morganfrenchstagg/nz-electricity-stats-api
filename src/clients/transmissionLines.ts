import { isValidTransmissionLines } from "../services/transmissionLines/transmissionLines";

// Same query the nz-electricity-map frontend uses for its transmission line layer.
const TRANSMISSION_LINES_URL = "https://services3.arcgis.com/AkUq3zcWf7TVqyR9/arcgis/rest/services/TransmissionLines/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson";

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
