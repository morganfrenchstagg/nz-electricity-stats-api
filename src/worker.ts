import { Hono } from "hono";
import { cors } from "hono/cors";
import { syncOffers } from "./sync/syncOffers";
import { syncDispatch } from "./sync/syncDispatch";
import dispatchApi from "./api/dispatchApi";
import { getGenerators } from "./clients/generators";
import { getSubstations } from "./clients/substations";
import { syncDailyDispatch } from "./sync/syncDailyDispatch";
import { syncDispatchAggregates } from "./sync/syncDispatchAggregates";
import { syncGenerationRecords } from "./sync/syncGenerationRecords";
import offersApi from "./api/offersApi";
import { getJsonResponseWithMaxAgeHeader } from "./utilities/utilities";
import outagesApi from "./api/outagesApi";
import transmissionLinesApi from "./api/transmissionLinesApi";

const app = new Hono();

app.use(cors());

// catches anything the routes (including the mounted sub-apps) don't handle themselves, so callers get a JSON
// body instead of Hono's plain-text 500
app.onError((err, c) => {
  console.error(`Unhandled error for ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: "Internal server error" }, 500, { "Cache-Control": "no-store" });
});

app.get('/', async (c) => {
  return c.redirect("https://electricitymap.frenchsta.gg/");
});

app.get('ping', async (c) => {
  return c.text("pong");
});

app.get('/v1/definitions', async (c) => {
  const generators = await getGenerators();
  const substations = await getSubstations();

  const output = {
    generators,
    substations
  }

  return getJsonResponseWithMaxAgeHeader(output);
})

app.get('/v1/generators', async (c) => {
  return getJsonResponseWithMaxAgeHeader(await getGenerators());
});

app.get('/v1/substations', async (c) => {
  return getJsonResponseWithMaxAgeHeader(await getSubstations());
});

app.route('/v1/dispatch', dispatchApi);
app.route('/v1/offers', offersApi);
app.route('/v1/outages', outagesApi)
app.route('/v1/transmission-lines', transmissionLinesApi);


async function scheduled(controller: ScheduledController) {
  switch (controller.cron) {
    case "*/2 * * * *":
      await syncDispatch();
      break;
    case "02 * * * *":
      await syncDailyDispatch();
      await syncDispatchAggregates();
      await syncGenerationRecords();
      break;
    case "45 * * * *":
      await syncOffers();
      break;
  }
}

export default {
  fetch: app.fetch,
  scheduled: scheduled,
}