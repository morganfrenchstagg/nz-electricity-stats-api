import { env } from "cloudflare:workers";
import { OfferRecord } from "../models/offerRecord";
import { parse } from "csv-parse/browser/esm";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";

// stop starting new files after this long, so a long catch-up stops cleanly before the 15 minute limit
// for cron triggers. each file takes ~1 minute, the rest are picked up by the next run
const TIME_BUDGET_MS = 10 * 60 * 1000;

// each file (~240MB, ~1.5 million rows) uses ~20-30s of CPU, so this stays within the 5 minute CPU limit
const MAX_FILES_PER_RUN = 8;

export async function syncOffers() {
  console.log("Syncing offers");
  const startTime = Date.now();

  const lastSyncDate = await env.dispatch_kv.get("latestSyncedOffers");
  const filesToDownload = await getListOfFilesToDownload();

  const filteredFilesToDownload = lastSyncDate ? filesToDownload
    .filter(file => file.split('/').slice(-1)[0].split('_')[0] > lastSyncDate) : filesToDownload;

  for (const [i, file] of filteredFilesToDownload.entries()) {
    if (i >= MAX_FILES_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`Stopping for this run, ${filteredFilesToDownload.length - i} file(s) left to sync`);
      break;
    }

    console.log("Downloading file: " + file);
    const parsedData = await downloadFileAndParse(file);
    const fileDate = file.split('/').slice(-1)[0].split('_')[0];
    await env.offers.put("offers-" + fileDate, JSON.stringify(parsedData));
    await env.dispatch_kv.put("latestSyncedOffers", fileDate);
    console.log("Finished syncing " + fileDate + "\n");
  }

  console.log("Finished syncing offers");
}

async function downloadFileAndParse(url: string) {
  const response = await fetch(url);
  console.log("Finished downloading file: " + url);

  const startTime = performance.now();

  const output = {} as Record<string, any>;

  const parser = parse({ columns: true });

  parser.on("readable", function () {
    let record;
    while ((record = parser.read()) !== null) {
      const item = record as OfferRecord;
      if (item.IsLatestYesNo === 'Y' && item.ProductClass === 'Injection' && item.ProductType === 'Energy' && +item.Megawatts > 0) {
        const tradingPeriod = +item.TradingPeriod;

        const pointOfConnectionAndUnit = item.PointOfConnection + " " + item.Unit;

        if (!output[tradingPeriod]) {
          output[tradingPeriod] = {};
        }

        const thisTranche = {
          tranche: +item.Tranche,
          megawatts: item.ForecastOfGenerationPotentialMegawatts ? +item.ForecastOfGenerationPotentialMegawatts : +item.Megawatts,
          price: +item.DollarsPerMegawattHour
        };

        output[tradingPeriod][pointOfConnectionAndUnit] = [...(output[tradingPeriod][pointOfConnectionAndUnit] || []), thisTranche];
      }
    }
  });

  const decoder = new TextDecoder();

  for await (const chunk of response.body!) {
    // Decode the file data as a UTF-8 string, and send it to the CSV parser.
    const ready = parser.write(decoder.decode(chunk));

    // If the CSV parser is backed up, block it emits a `drain` event, which
    // means it is ready to receive more data.
    if (!ready) {
      parser.once("drain", () => { });
    }
  }

  parser.end();

  const endTime = performance.now()

  console.log(`Finished parsing in ${endTime - startTime} milliseconds`);

  return output;
}

async function getListOfFilesToDownload(): Promise<string[]> {
  const blobs = await listEmiDatasetBlobs("Datasets/Wholesale/BidsAndOffers/Offers");

  return blobs
    .filter(blob => blob.name.endsWith("_Offers.csv"))
    .map(blob => blob.url);
}
