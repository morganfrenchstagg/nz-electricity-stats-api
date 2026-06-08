import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();
app.use(cors());

app.get(":date", async (c) => {
    let date = c.req.param("date");

    if (date === "latest") {
        date = await env.dispatch_kv.get("latestSyncedOffers");
    }

    const formattedDate = date.replace(/-/g, '');
    const fileKey = "offers-" + formattedDate;
    const response = await env.offers.get(fileKey);

    console.log("Fetching offers for key: " + fileKey);

    if (!response) {
        c.status(404);
        return c.json({ message: "No data for this date" });
    }

    const json = await response.json();

    return c.json(json);
});

export default app;