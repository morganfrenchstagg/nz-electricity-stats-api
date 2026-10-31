import { env } from "cloudflare:workers";
import { downloadFileAndParse, getListOfEmiFiles, MAX_CONCURRENT_DOWNLOADS } from "./syncOffers";

// every day up to this date (YYYYMMDD) with an offers file has been given a fogp file
const CHECKPOINT_KEY = "latestBackfilledFogp";

// EMI's offers have no forecasts of generation potential before 24 October 2019, so the days before then are left
// without a fogp file
const LAST_DATE_WITHOUT_FOGP = "20191023";

// the backfill is about 2,500 files, mostly ~25MB before 2024 and ~250MB since 2025 (about 190GB in all), so it takes
// many runs. like syncOffers, a run stops starting new files after 10 minutes, before the 15 minute limit for cron
// triggers, and after 150 files (~0.5s of CPU each), well within the 5 minute CPU limit
const TIME_BUDGET_MS = 10 * 60 * 1000;
const MAX_FILES_PER_RUN = 150;

/**
 * Saves the forecast of generation potential (see syncOffers) for the days synced before the offers sync kept it,
 * which have an offers file but no fogp file. Only the fogp files are written, so the offers and latestSyncedOffers
 * are left as they are.
 *
 * Once it's caught up, a run only lists the days synced since the last run, which syncOffers has already saved both
 * files for, so it has nothing to download
 */
export async function backfillFogp() {
  console.log("Backfilling FOGP");
  const startTime = Date.now();

  const checkpoint = await env.dispatch_kv.get(CHECKPOINT_KEY) ?? LAST_DATE_WITHOUT_FOGP;
  const [offerDates, fogpDates] = await Promise.all([listDatesAfter("offers-", checkpoint), listDatesAfter("fogp-", checkpoint)]);
  if (offerDates.length === 0) {
    console.log("No new offers to check for FOGP");
    return;
  }

  const hasFogp = new Set(fogpDates);
  const missing = new Set(offerDates.filter(date => !hasFogp.has(date)));
  // EMI's listing is oldest first, so the checkpoint only moves past days that have been backfilled
  const filesToDownload = missing.size > 0 ? (await getListOfEmiFiles()).filter(file => missing.has(file.date)) : [];

  for (let i = 0; i < filesToDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (i >= MAX_FILES_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`Stopping for this run, ${filesToDownload.length - i} day(s) of FOGP left to backfill`);
      return;
    }

    const batch = filesToDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS);

    await Promise.all(batch.map(async (file) => {
      const { forecasts } = await downloadFileAndParse(file.url);
      await env.offers.put("fogp-" + file.date, JSON.stringify(forecasts));
    }));

    await env.dispatch_kv.put(CHECKPOINT_KEY, batch[batch.length - 1].date);
    console.log("Backfilled FOGP for " + batch.map(file => file.date).join(", "));
  }

  // every day with an offers file now has a fogp file (or EMI no longer has its offers), so the next run starts after them
  await env.dispatch_kv.put(CHECKPOINT_KEY, offerDates[offerDates.length - 1]);
  console.log("Finished backfilling FOGP");
}

// the dates (YYYYMMDD) of the files in the offers bucket with the prefix (e.g. offers-), after the given date, oldest first
async function listDatesAfter(prefix: string, date: string): Promise<string[]> {
  const dates = [] as string[];
  let cursor: string | undefined;

  do {
    const listing = await env.offers.list({ prefix, startAfter: prefix + date, cursor });
    dates.push(...listing.objects.map(object => object.key.slice(prefix.length)));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  return dates;
}
