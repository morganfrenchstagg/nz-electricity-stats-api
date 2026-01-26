import { env } from "cloudflare:workers";
import { Hono } from "hono";

const app = new Hono();

app.get("/", async (c) => {
	const dispatch = await env.DB.prepare(`SELECT * FROM real_time_dispatch WHERE FiveMinuteIntervalDateTime >= DATE('now', '-1 day')`).all();
	return c.json(dispatch.results);
});

app.get("/delta", async (c) => {
	const list = await fetch('https://raw.githubusercontent.com/morganfrenchstagg/nz-electricity-map/refs/heads/main/backend/data/generators.json');
	const generationListJson = await list.json();

	const lastSynced = await env.DB.prepare(`SELECT MAX(FiveMinuteIntervalDatetime) FROM real_time_dispatch`).first("MAX(FiveMinuteIntervalDatetime)");

	const dispatchList = await env.DB.prepare(`SELECT DISTINCT PointOfConnectionCode FROM real_time_dispatch`).all();

	const dispatchListResult = dispatchList.results.map(dispatch => dispatch.PointOfConnectionCode);

	const unitsUnaccountedForInDispatchList = dispatchListResult;
	const unitsMissingInDispatchList = [];

	for(const generator of generationListJson){
		for(const unit of generator.units){
			if(!dispatchListResult.includes(unit.node)){
				unitsMissingInDispatchList.push(unit.node);
			} else {
				unitsUnaccountedForInDispatchList.splice(unitsUnaccountedForInDispatchList.indexOf(unit.node), 1);
			}
		}
	}

	
	return c.json({
		lastSynced: lastSynced,
		unitsMissingInDispatchList: unitsMissingInDispatchList,
		unitsUnaccountedForInDispatchList: unitsUnaccountedForInDispatchList.filter(unit => unit.split(' ').length > 1)
	});
})

export default app;