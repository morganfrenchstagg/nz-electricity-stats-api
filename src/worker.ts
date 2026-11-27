import app from "./app";
import { syncOffers } from "./sync/syncOffers";
import { syncDispatch } from "./sync/syncDispatch";
import { syncDailyDispatch } from "./sync/syncDailyDispatch";
import { syncDispatchAggregates } from "./sync/syncDispatchAggregates";
import { syncGenerationRecords } from "./sync/syncGenerationRecords";
import { syncMeteredGeneration } from "./sync/syncMeteredGeneration";
import { syncHvdc } from "./sync/syncHvdc";
import { syncHvdcHistory } from "./sync/syncHvdcHistory";
import { backfillFogp } from "./sync/backfillFogp";
import { checkForStaleData } from "./sync/staleDataCheck";

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
};
