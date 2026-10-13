import { Hono } from "hono";
import { cors } from "hono/cors";
import { getOutageListFromCache } from "../clients/pocpApi";
import { getJsonResponseWithHeaders, ONE_HOUR_IN_SECONDS } from "../utilities/utilities";

const app = new Hono();
app.use(cors());

app.get("", async (c) => {
    let output = {} as Record<string, any>;
    const outagesByUnit = await getOutageListFromCache();

    for (const unit in outagesByUnit) {
        output[unit] = outagesByUnit[unit].map((a) => {
            return {
                outageBlock: a.outageBlock,
                timeStart: a.timeStart,
                timeEnd: a.timeEnd,
                mwattLost: a.mwattLost
            }
        });
    }

    return getJsonResponseWithHeaders(output, { "Cache-Control": `max-age=${ONE_HOUR_IN_SECONDS}` })
})

export default app;