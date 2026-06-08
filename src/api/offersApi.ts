import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getJsonResponseWithHeaders, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "../utilities/utilities";

const app = new Hono();
app.use(cors());

app.get(":date", async (c) => {
    let date = c.req.param("date");

    if (date === "latest") {
        date = (await env.dispatch_kv.get("latestSyncedOffers"))!;
    }

    const formattedDate = date.replace(/-/g, '');
    const fileKey = "offers-" + formattedDate;
    const data = await env.offers.get(fileKey);

    if (!data) {
        c.status(404);
        return c.json({ message: "No data for this date" });
    }

    const json = await data.json();

    const response = {
        date: formattedDate,
        data: json
    }

    const maxAgeSeconds = c.req.param("date") === "latest" ? ONE_HOUR_IN_SECONDS : ONE_DAY_IN_SECONDS;

    return getJsonResponseWithHeaders(response, { "Cache-Control": `max-age=${maxAgeSeconds}` });
});

export default app;