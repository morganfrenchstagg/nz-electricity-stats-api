import { env } from "cloudflare:workers";
import { getElementsByTagName, getText } from "domutils";
import { parseDocument } from "htmlparser2";
import { OfferRecord } from "../models/offerRecord";
import { parse } from "csv-parse/browser/esm";

export async function syncOffers() {
  console.log("Syncing offers");

  const lastSyncDate = await env.dispatch_kv.get("latestSyncedOffers");
  const filesToDownload = await getListOfFilesToDownload();

  const filteredFilesToDownload = lastSyncDate ? filesToDownload
    .filter(file => file.split('/').slice(-1)[0].split('_')[0] > lastSyncDate) : filesToDownload;

  for (const file of filteredFilesToDownload) {
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
          megawatts: +item.Megawatts,
          price: +item.DollarsPerMegawattHour
        };

        output[tradingPeriod][pointOfConnectionAndUnit] = [...(output[tradingPeriod][pointOfConnectionAndUnit] || []), thisTranche];
      }
    }
  });

  const decoder = new TextDecoder();

  for await (const chunk of response.body) {
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
  const response = await fetch("https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/BidsAndOffers/Offers");

  const data = await response.text();


  const xmlDoc = parseDocument(data, { xmlMode: true, decodeEntities: true });
  const blobs = getElementsByTagName("Blob", xmlDoc);

  const filesToDownload: string[] = [];

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const name = getText(getElementsByTagName("Name", blob)[0]) || "";
    if (name.endsWith("_Offers.csv")) {
      filesToDownload.push(getText(getElementsByTagName("Url", blob)[0]));
    }
  }

  return filesToDownload;
}