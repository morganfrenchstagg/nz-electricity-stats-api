import { Hono } from "hono";
import { cors } from "hono/cors";
import { syncOffers } from "./sync/syncOffers";
import { syncDispatch } from "./sync/syncDispatch";
import dispatchApi from "./api/dispatchApi";
import { getGenerators } from "./clients/generators";
import { getSubstations } from "./clients/substations";
import { syncDailyDispatch } from "./sync/syncDailyDispatch";
import offersApi from "./api/offersApi";
import { getJsonResponseWithMaxAgeHeader } from "./utilities/utilities";

const app = new Hono();

app.use(cors());

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


async function scheduled(controller: ScheduledController) {
  switch (controller.cron) {
    case "*/2 * * * *":
      await syncDispatch();
      break;
    case "02 * * * *":
      await syncDailyDispatch();
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