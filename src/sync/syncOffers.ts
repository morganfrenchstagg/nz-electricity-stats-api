import { env } from "cloudflare:workers";
import { OfferRecord } from "../models/offerRecord";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";
import { CsvRecordParser } from "../services/csvToJson/csvToJson";
import { LineFilter } from "../services/lineFilter/lineFilter";
import { CheckpointMetadata } from "../models/checkpointMetadata";

// files are downloaded in parallel batches. only the few rows we keep are parsed, so 3 files in progress use
// ~10MB of memory (~30MB including garbage) - well within the 128MB limit
const MAX_CONCURRENT_DOWNLOADS = 3;

// stop starting new files after this long, so a long catch-up stops cleanly before the 15 minute limit
// for cron triggers. the rest are picked up by the next run
const TIME_BUDGET_MS = 10 * 60 * 1000;

// each file uses ~0.5s of CPU, so this leaves plenty of headroom within the 5 minute CPU limit
const MAX_FILES_PER_RUN = 150;

type OffersFile = {
  date: string; // YYYYMMDD
  url: string;
}

export async function syncOffers() {
  console.log("Syncing offers");
  const startTime = Date.now();

  const [emiFiles, lastSyncDate] = await Promise.all([
    getListOfEmiFiles(),
    env.dispatch_kv.get("latestSyncedOffers"),
  ]);

  const filesToDownload = lastSyncDate ? emiFiles.filter(file => file.date > lastSyncDate) : emiFiles;

  for (let i = 0; i < filesToDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (i >= MAX_FILES_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`Stopping for this run, ${filesToDownload.length - i} file(s) left to sync`);
      break;
    }

    const batch = filesToDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS);

    await Promise.all(batch.map(async (file) => {
      const { offers, forecasts } = await downloadFileAndParse(file.url);
      await Promise.all([
        env.offers.put("offers-" + file.date, JSON.stringify(offers)),
        env.offers.put("fogp-" + file.date, JSON.stringify(forecasts)),
      ]);
    }));

    const metadata: CheckpointMetadata = { updatedAt: Date.now() };
    await env.dispatch_kv.put("latestSyncedOffers", batch[batch.length - 1].date, { metadata });
    console.log("Synced " + batch.map(file => file.date).join(", "));
  }

  console.log("Finished syncing offers");
}

async function downloadFileAndParse(url: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const offers = {} as Record<string, Record<string, { tranche: number, megawatts: number, price: number }[]>>;
  // intermittent units (wind, some solar) also give a forecast of generation potential (FOGP), by trading period
  // and unit. only units that give one are included
  const forecasts = {} as Record<string, Record<string, number>>;
  // the submission (SubmissionOrder) each forecast is from, by trading period and unit
  const forecastSubmissions = {} as Record<string, Record<string, number>>;

  const parser = new CsvRecordParser((record) => {
    const item = record as OfferRecord;
    if (item.IsLatestYesNo !== 'Y' || item.ProductClass !== 'Injection' || item.ProductType !== 'Energy') {
      return;
    }

    const pointOfConnectionAndUnit = item.PointOfConnection + " " + item.Unit;

    // EMI repeats the unit's whole forecast on each of its tranches, including ones with nothing offered. it isn't
    // used for the offers, so each tranche is what was offered in it, even when they add up to more than the forecast.
    // a tranche's latest offer can be from an earlier submission than the unit's other tranches, with the forecast
    // from then (most were before 2025), so the forecast is from the unit's latest submission
    if (item.ForecastOfGenerationPotentialMegawatts) {
      const submissions = forecastSubmissions[+item.TradingPeriod] ??= {};
      if (+item.SubmissionOrder >= (submissions[pointOfConnectionAndUnit] ?? 0)) {
        submissions[pointOfConnectionAndUnit] = +item.SubmissionOrder;
        (forecasts[+item.TradingPeriod] ??= {})[pointOfConnectionAndUnit] = +item.ForecastOfGenerationPotentialMegawatts;
      }
    }

    if (+item.Megawatts > 0) {
      const tradingPeriod = offers[+item.TradingPeriod] ??= {};
      (tradingPeriod[pointOfConnectionAndUnit] ??= []).push({
        tranche: +item.Tranche,
        megawatts: +item.Megawatts,
        price: +item.DollarsPerMegawattHour
      });
    }
  });

  // only ~2% of rows are the latest offers (IsLatestYesNo is Y), so the rest are skipped without being parsed.
  // EMI's offers files have no quoted fields, so each line is always a whole row
  const lineFilter = new LineFilter(",Y,", (text) => parser.write(text));

  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    lineFilter.write(decoder.decode(chunk, { stream: true }));
  }
  lineFilter.write(decoder.decode());
  lineFilter.end();
  parser.end();

  return { offers, forecasts };
}

async function getListOfEmiFiles(): Promise<OffersFile[]> {
  const blobs = await listEmiDatasetBlobs("Datasets/Wholesale/BidsAndOffers/Offers");

  return blobs
    .filter(blob => blob.name.endsWith("_Offers.csv"))
    .map(blob => ({
      date: blob.name.split('/').slice(-1)[0].split('_')[0],
      url: blob.url,
    }));
}
