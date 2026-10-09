import { env } from "cloudflare:workers";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { CsvRecordParser } from "../services/csvToJson/csvToJson";
import { EmiDailyFile, selectFilesToDownload } from "../services/dailyDispatchFiles/selectFilesToDownload";
import { queueForReaggregation } from "./syncDispatchAggregates";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";

// files are downloaded in parallel batches. each file in progress uses up to ~20MB of memory - 3 at a time
// stays comfortably within the 128MB limit, 4 caused heavy garbage collection with the largest files
const MAX_CONCURRENT_DOWNLOADS = 3;

// stop starting new files after this long, so a long (re-)sync stops cleanly before the 15 minute limit
// for cron triggers, leaving time for the aggregates to run. the rest are picked up by the next run
const TIME_BUDGET_MS = 10 * 60 * 1000;

// each file uses ~0.25s of CPU, so this leaves plenty of headroom within the 5 minute CPU limit
const MAX_FILES_PER_RUN = 500;

export async function syncDailyDispatch() {
    console.log("Syncing daily dispatch");
    const startTime = Date.now();

    const [emiFiles, lastSyncDate, storedUploadTimes] = await Promise.all([
        getListOfEmiFiles(),
        env.dispatch_kv.get("latestDailySyncDate"),
        getStoredUploadTimes(),
    ]);
    console.log("Syncing any files posted since: " + lastSyncDate)

    const filesToDownload = selectFilesToDownload(emiFiles, lastSyncDate, storedUploadTimes);

    const republished = filesToDownload.filter(file => lastSyncDate && file.date <= lastSyncDate);
    if (republished.length > 0) {
        console.log("Re-downloading files that are missing or have been republished: " + republished.map(file => file.date).join(", "));
    }

    if (filesToDownload.length === 0) {
        console.log("No new files to download");
        return;
    }

    let checkpoint = lastSyncDate;

    for (let i = 0; i < filesToDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
        if (i >= MAX_FILES_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
            console.log(`Stopping for this run, ${filesToDownload.length - i} file(s) left to sync`);
            break;
        }

        const batch = filesToDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS);

        await Promise.all(batch.map(async (file) => {
            const data = await downloadFileAndParse(file.url);
            await env.dispatch.put("dispatch-" + file.date, JSON.stringify(data));
        }));

        await queueForReaggregation(batch.map(file => file.date));

        // republished files are older than the checkpoint, so only move it forward
        const lastDate = batch[batch.length - 1].date;
        if (!checkpoint || lastDate > checkpoint) {
            checkpoint = lastDate;
            await env.dispatch_kv.put("latestDailySyncDate", checkpoint);
        }

        console.log("Synced " + batch.map(file => file.date).join(", "));
    }

    console.log("Finished syncing daily dispatch");
}

async function downloadFileAndParse(url: string) {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${url}: ${response.status}`);
    }

    let out = {} as Record<string, HistoricalDispatchRecord[]>;

    // rows are converted as the file downloads, rather than holding the whole file in memory
    const parser = new CsvRecordParser((item) => {
        const time = item.IntervalDateTime.split('.')[0];
        (out[time] ??= []).push({
            p: item.PointOfConnectionCode + (item.UnitCode == "N/A" ? "" : ` ${item.UnitCode}`),
            l: item.LoadMegawatts,
            g: item.GenerationMegawatts,
            c: item.DollarsPerMegawattHour,
        });
    });

    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
        parser.write(decoder.decode(chunk, { stream: true }));
    }
    parser.write(decoder.decode());
    parser.end();

    return out;
}

// when each stored daily file was last written, by date (e.g. 20261008)
async function getStoredUploadTimes(): Promise<Map<string, number>> {
    const uploadTimes = new Map<string, number>();
    let cursor: string | undefined;

    do {
        const listing = await env.dispatch.list({ prefix: "dispatch-", cursor });
        for (const object of listing.objects) {
            uploadTimes.set(object.key.replace("dispatch-", ""), object.uploaded.getTime());
        }
        cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);

    return uploadTimes;
}

async function getListOfEmiFiles(): Promise<EmiDailyFile[]> {
    const blobs = await listEmiDatasetBlobs("Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/");

    return blobs
        .filter(blob => blob.name.endsWith("DispatchNodalPricesAndVolumes.csv"))
        .map(blob => ({
            date: blob.name.split('/').slice(-1)[0].split('_')[0],
            url: blob.url,
            lastModified: blob.lastModified,
        }));
}
