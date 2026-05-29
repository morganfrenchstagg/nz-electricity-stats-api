import { Hono } from "hono";
import { cors } from "hono/cors";
import { syncOffers } from "./sync/syncOffers";
import { checkForMissingUnitsToday, syncDispatch } from "./sync/syncDispatch";
import dispatchApi from "./api/dispatchApi";
import { getGenerators } from "./clients/generators";
import { getSubstations } from "./clients/substations";
import { syncDailyDispatch } from "./sync/syncDailyDispatch";

const app = new Hono();

app.use(cors());

app.get('/', async (c) => {
  return c.redirect("https://electricitymap.frenchsta.gg/");
});

app.get('ping', async (c) => {
  return c.text("pong");
});

app.get('/v1/generators', async (c) => {
  return c.json(await getGenerators());
});

app.get('/v1/substations', async (c) => {
  return c.json(await getSubstations());
});

app.route('/v1/dispatch', dispatchApi);


async function scheduled(controller: ScheduledController) {
  switch (controller.cron) {
    case "*/2 * * * *":
      await syncDispatch();
      break;
    case "0 12 * * *":
      await checkForMissingUnitsToday();
      break;
    case "*/20 * * * *":
      await syncDailyDispatch();
      break;
    /*case "30 * * * *":
      await syncOffers();
      break;*/
  }
}

export default {
  fetch: app.fetch,
  scheduled: scheduled,
}