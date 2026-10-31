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
import { syncMeteredGeneration } from "./sync/syncMeteredGeneration";
import { syncHvdc } from "./sync/syncHvdc";
import { syncHvdcHistory } from "./sync/syncHvdcHistory";
import { backfillFogp } from "./sync/backfillFogp";
import { checkForStaleData } from "./sync/staleDataCheck";
import offersApi from "./api/offersApi";
import { getJsonResponseWithMaxAgeHeader } from "./utilities/utilities";
import outagesApi from "./api/outagesApi";
import transmissionLinesApi from "./api/transmissionLinesApi";
import { ATTRIBUTION, ATTRIBUTION_LINK } from "./attribution";

const app = new Hono();

app.use(cors());

// catches anything the routes (including the mounted sub-apps) don't handle themselves, so callers get a JSON
// body instead of Hono's plain-text 500
app.onError((err, c) => {
  console.error(`Unhandled error for ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: "Internal server error" }, 500, { "Cache-Control": "no-store" });
});

// every data response points to where its sources and licences are credited (see attribution.ts)
app.use('/v1/*', async (c, next) => {
  await next();
  c.header("Link", ATTRIBUTION_LINK, { append: true });
});

app.get('/', async (c) => {
  return c.body(null, 200);
});

app.get('ping', async (c) => {
  return c.text("pong");
});

app.get('/v1/attribution', async (c) => {
  return getJsonResponseWithMaxAgeHeader(ATTRIBUTION);
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
      // first, as it logs rather than throws when em6 is unavailable, so it's synced even when the dispatch sync fails
      await syncHvdc();
      try {
        await syncDispatch();
      } finally {
        // checked even when the sync fails, as that's when the data goes stale
        await checkForStaleData();
      }
      break;
    case "02 * * * *":
      await syncDailyDispatch();
      await syncDispatchAggregates();
      await syncGenerationRecords();
      break;
    // the metered generation backfill is mostly waiting on R2, so it has runs of its own to get through it sooner.
    // it rewrites the annual aggregates too, so it starts after the hourly sync above has had time to finish (it can
    // take ~10 minutes when it's catching up), and each run stops before the next one (see syncMeteredGeneration)
    case "15,30,45 * * * *":
      await syncMeteredGeneration();
      break;
    case "45 * * * *":
      await syncOffers();
      break;
    // only writes the HVDC's own files, so it can run alongside the others
    case "05 * * * *":
      await syncHvdcHistory();
      break;
    // the FOGP backfill downloads years of the offers sync's files, so it has runs of its own rather than using up the
    // offers sync's time. it only writes the fogp files the offers sync hasn't, so it can run alongside the others
    case "25 * * * *":
      await backfillFogp();
      break;
  }
}

export default {
  fetch: app.fetch,
  scheduled: scheduled,
}