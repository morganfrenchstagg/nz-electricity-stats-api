import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getJsonResponseWithHeaders, getServiceUnavailableResponse, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "../utilities/utilities";

const app = new Hono();
app.use(cors());

app.get(":date", async (c) => {
    let date = c.req.param("date");

    if (date === "latest") {
        const latestSyncedOffers = await env.dispatch_kv.get("latestSyncedOffers");
        if (!latestSyncedOffers) {
            return getServiceUnavailableResponse("Offers have not been synced yet");
        }
        date = latestSyncedOffers;
    }

    const formattedDate = date.replace(/-/g, '');
    const [data, fogp] = await Promise.all([
        env.offers.get("offers-" + formattedDate),
        env.offers.get("fogp-" + formattedDate),
    ]);

    if (!data) {
        c.status(404);
        return c.json({ message: "No data for this date" });
    }

    const response = {
        date: formattedDate,
        data: await data.json(),
        // intermittent units' forecast of generation potential, by trading period and unit. EMI's offers only have it
        // from 24 October 2019, and the days synced before late October 2026 have none until they're backfilled (see
        // backfillFogp)
        fogp: fogp ? await fogp.json() : {}
    }

    // todo - better calculate an appropriate amount of time for this cache to last
    const maxAgeSeconds = c.req.param("date") === "latest" ? ONE_HOUR_IN_SECONDS : ONE_DAY_IN_SECONDS;

    return getJsonResponseWithHeaders(response, { "Cache-Control": `max-age=${maxAgeSeconds}` });
});

export default app;