import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchTransmissionLinesFromArcgis } from "../clients/transmissionLines";
import { TRANSMISSION_LINES_MAX_AGE_SECONDS } from "../services/transmissionLines/transmissionLines";
import { edgeCache } from "../utilities/edgeCache";

const app = new Hono();
app.use(cors());

// a proxy to ArcGIS, with the edge cache keeping each data center to about one request a day. the lines rarely change
app.get("", edgeCache, async (c) => {
    try {
        const body = await fetchTransmissionLinesFromArcgis();
        return c.body(body, 200, {
            "Content-Type": "application/geo+json",
            "Cache-Control": `public, max-age=${TRANSMISSION_LINES_MAX_AGE_SECONDS}`
        });
    } catch (e) {
        console.error("Failed to load transmission lines", e);
        return c.json({ error: "Transmission lines are temporarily unavailable" }, 502, {
            "Cache-Control": "no-store"
        });
    }
});

export default app;
