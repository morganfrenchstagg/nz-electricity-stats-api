import { env } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { AggregateResolution, DispatchAggregate } from "../models/dispatchAggregate";
import { getAggregateKey, getMonthBounds, toTimeseries } from "../services/dispatchAggregation/dispatchAggregation";
import { LATEST_AGGREGATED_DATE_KEY } from "../sync/syncDispatchAggregates";
import { getJsonResponseWithHeaders, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "../utilities/utilities";

const app = new Hono();
app.use(cors());

app.get("/", async (c) => {
	return c.json({
		latestDate: await env.dispatch_kv.get(LATEST_AGGREGATED_DATE_KEY)
	});
});

// e.g. /2026/weekly - one data point per ISO week (Monday to Sunday) in the year
app.get("/:year{[0-9]{4}}/weekly", async (c) => {
	return getAggregateResponse(c, "weekly", c.req.param("year"));
});

// e.g. /2026/monthly - one data point per month in the year
app.get("/:year{[0-9]{4}}/monthly", async (c) => {
	return getAggregateResponse(c, "monthly", c.req.param("year"));
});

// e.g. /2026/10 - one data point per day in the month
app.get("/:year{[0-9]{4}}/:month{[0-9]{1,2}}", async (c) => {
	const month = +c.req.param("month");
	if (month < 1 || month > 12) {
		c.status(400);
		return c.json({ message: "Invalid month, expected 1-12" });
	}
	return getAggregateResponse(c, "daily", `${c.req.param("year")}-${String(month).padStart(2, "0")}`);
});

// /annual - one data point per year
app.get("/annual", async (c) => {
	return getAggregateResponse(c, "annual", "all");
});

async function getAggregateResponse(c: Context, resolution: AggregateResolution, period: string) {
	const file = await env.dispatch.get(getAggregateKey(resolution, period));

	if (!file) {
		c.status(404);
		return c.json({ message: "No data for this period" });
	}

	const aggregate = await file.json() as DispatchAggregate;

	// optionally filter by a comma separated list of node prefixes, e.g. ?nodes=HLY2201,ABY0111
	const nodeFilter = c.req.query("nodes")?.split(",").map(node => node.trim()).filter(node => node.length > 0);
	const timeseries = toTimeseries(aggregate, nodeFilter);

	// files for periods still receiving data are refreshed daily, so only cache them briefly
	const latestDate = await env.dispatch_kv.get(LATEST_AGGREGATED_DATE_KEY);
	const isComplete = resolution !== "annual" && latestDate !== null && getPeriodEnd(resolution, period) < latestDate;
	const maxAgeSeconds = isComplete ? ONE_DAY_IN_SECONDS : ONE_HOUR_IN_SECONDS;

	return getJsonResponseWithHeaders(timeseries, { "Cache-Control": `max-age=${maxAgeSeconds}` });
}

function getPeriodEnd(resolution: AggregateResolution, period: string): string {
	if (resolution === "daily") {
		return getMonthBounds(period).to;
	}
	// weekly files are by ISO week year, so can include up to the first few days of the following year
	return resolution === "weekly" ? `${+period + 1}-01-03` : `${period}-12-31`;
}

export default app;
