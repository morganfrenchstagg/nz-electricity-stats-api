import { Hono } from "hono";
import { cors } from "hono/cors";
import { getOutageListFromCache, getOutageListFromPocpBetween, OUTAGE_DAYS_BEFORE } from "../clients/pocpApi";
import { getGenerators } from "../clients/generators";
import { mapOutagesByUnit } from "../services/outageMapping/outageMapper";
import { PocpOutage } from "../models/pocpOutage";
import { addDays, parseNzTime } from "../mcp/dates";
import { edgeCache } from "../utilities/edgeCache";
import { getJsonResponseWithHeaders, getServiceUnavailableResponse, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "../utilities/utilities";

const app = new Hono();
app.use(cors());

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const ONE_DAY_IN_MS = ONE_DAY_IN_SECONDS * 1000;
// POCP keeps revising outages for a few days after they end (e.g. to when they were completed), so a day's are only
// cached for long once it's older than the rolling window the sync keeps
const SETTLED_MAX_AGE_SECONDS = 7 * ONE_DAY_IN_SECONDS;

// a real date, not just one in the format (e.g. 2026-02-30, which Date.parse takes to be 2 March)
function isValidDate(date: string): boolean {
    const time = Date.parse(date);
    return DATE_FORMAT.test(date) && !isNaN(time) && new Date(time).toISOString().slice(0, 10) === date;
}

function toResponse(outagesByUnit: Record<string, PocpOutage[]>) {
    const output = {} as Record<string, any>;
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
    return output;
}

app.get("", async (c) => {
    const outagesByUnit = await getOutageListFromCache();
    return getJsonResponseWithHeaders(toResponse(outagesByUnit), { "Cache-Control": `max-age=${ONE_HOUR_IN_SECONDS}` })
})

// the outages going on at any time in an NZ day (YYYY-MM-DD), by unit as above, from POCP's history, which goes back
// years before the rolling window /v1/outages has. each is mapped to the units in service as the day ends
app.get("/:date", edgeCache, async (c) => {
    const date = c.req.param("date");
    if (!isValidDate(date)) {
        c.status(400);
        return c.json({ message: "Invalid date, expected an NZ date like 2026-10-14" });
    }

    const from = parseNzTime(`${date}T00:00`);
    const to = parseNzTime(`${addDays(date, 1)}T00:00`);

    let outages: PocpOutage[];
    try {
        outages = await getOutageListFromPocpBetween(new Date(from), new Date(to));
    } catch (e) {
        console.error(`Failed to fetch outages for ${date} from POCP`, e);
        return getServiceUnavailableResponse("Outages are temporarily unavailable");
    }

    const dayOutages = outages.filter(outage => Date.parse(outage.timeStart) < to && Date.parse(outage.timeEnd) > from);
    const outagesByUnit = mapOutagesByUnit(dayOutages, await getGenerators(), to - 1);

    // none at all can be POCP failing rather than nothing being out, so that's asked for again as soon as a recent day is
    const isSettled = to < Date.now() - OUTAGE_DAYS_BEFORE * ONE_DAY_IN_MS && outages.length > 0;
    const maxAge = isSettled ? SETTLED_MAX_AGE_SECONDS : ONE_HOUR_IN_SECONDS;
    return getJsonResponseWithHeaders(toResponse(outagesByUnit), { "Cache-Control": `max-age=${maxAge}` });
})

export default app;
