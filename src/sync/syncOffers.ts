import { env } from "cloudflare:workers";
import { OfferRecord } from "../models/offerRecord";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";
import { CsvRecordParser } from "../services/csvToJson/csvToJson";
import { LineFilter } from "../services/lineFilter/lineFilter";

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
      const data = await downloadFileAndParse(file.url);
      await env.offers.put("offers-" + file.date, JSON.stringify(data));
    }));

    await env.dispatch_kv.put("latestSyncedOffers", batch[batch.length - 1].date);
    console.log("Synced " + batch.map(file => file.date).join(", "));
  }

  console.log("Finished syncing offers");
}

async function downloadFileAndParse(url: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const output = {} as Record<string, Record<string, { tranche: number, megawatts: number, price: number }[]>>;

  const parser = new CsvRecordParser((record) => {
    const item = record as OfferRecord;
    if (item.IsLatestYesNo === 'Y' && item.ProductClass === 'Injection' && item.ProductType === 'Energy' && +item.Megawatts > 0) {
      const pointOfConnectionAndUnit = item.PointOfConnection + " " + item.Unit;
      const tradingPeriod = output[+item.TradingPeriod] ??= {};

      (tradingPeriod[pointOfConnectionAndUnit] ??= []).push({
        tranche: +item.Tranche,
        megawatts: item.ForecastOfGenerationPotentialMegawatts ? +item.ForecastOfGenerationPotentialMegawatts : +item.Megawatts,
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

  return output;
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
