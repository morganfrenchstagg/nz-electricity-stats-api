import { isValidTransmissionLines } from "../services/transmissionLines/transmissionLines";

// ArcGIS simplifies the lines for us: at full detail they're 1.15 MB compressed, 94k points
// to 15 decimal places. Simplifying to within ~5 m (0.00005°) and rounding to ~1 m (5 places)
// keeps 13k points, about 85 KB compressed, and stays under a pixel until zoom 14 or so.
// Only the fields worth showing are kept, dropping ArcGIS's ids and the length of the
// unsimplified line.
const TRANSMISSION_LINES_URL = "https://services3.arcgis.com/AkUq3zcWf7TVqyR9/arcgis/rest/services/TransmissionLines/FeatureServer/0/query?" + new URLSearchParams({
    where: "1=1",
    outFields: "MXLOCATION,designvolt,status,description,type",
    maxAllowableOffset: "0.00005",
    geometryPrecision: "5",
    f: "geojson",
});

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
