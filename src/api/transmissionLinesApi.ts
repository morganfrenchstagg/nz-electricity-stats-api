import { Hono } from "hono";
import { cors } from "hono/cors";
import { getTransmissionLines } from "../clients/transmissionLines";
import { TRANSMISSION_LINES_MAX_AGE_SECONDS } from "../services/transmissionLines/transmissionLines";

const app = new Hono();
app.use(cors());

app.get("", async (c) => {
    try {
        const body = await getTransmissionLines((p) => c.executionCtx.waitUntil(p));
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
