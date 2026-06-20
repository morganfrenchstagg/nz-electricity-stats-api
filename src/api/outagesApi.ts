import { Hono } from "hono";
import { cors } from "hono/cors";
import { getOutageListFromCache } from "../clients/pocpApi";
import { getJsonResponseWithMaxAgeHeader } from "../utilities/utilities";

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

    return getJsonResponseWithMaxAgeHeader(output)
})

export default app;