import { env } from "cloudflare:workers";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { CsvRecordParser } from "../services/csvToJson/csvToJson";
import { EmiDailyFile, selectFilesToDownload } from "../services/dailyDispatchFiles/selectFilesToDownload";
import { queueForReaggregation } from "./syncDispatchAggregates";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";
import { CheckpointMetadata } from "../models/checkpointMetadata";

// files are downloaded in parallel batches. each file in progress uses up to ~20MB of memory - 3 at a time
// stays comfortably within the 128MB limit, 4 caused heavy garbage collection with the largest files
const MAX_CONCURRENT_DOWNLOADS = 3;

// stop starting new files after this long, so a long (re-)sync stops cleanly before the 15 minute limit
// for cron triggers, leaving time for the aggregates to run. the rest are picked up by the next run
const TIME_BUDGET_MS = 10 * 60 * 1000;

// each file uses ~0.25s of CPU, so this leaves plenty of headroom within the 5 minute CPU limit
const MAX_FILES_PER_RUN = 500;

const FOLDER = "Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/";

// EMI usually republishes a day's file a few days after first publishing it, so each hourly run only checks the last
// couple of weeks' files (EMI keeps a folder for each year, e.g. .../2026/). it occasionally republishes older ones
// (e.g. a month of 2023's files at once, or a single day two months later), so one run a day checks every file
const RECENT_DAYS = 14;
const FULL_CHECK_UTC_HOUR = 12;

export async function syncDailyDispatch() {
    console.log("Syncing daily dispatch");
    const startTime = Date.now();

    const lastSyncDate = await env.dispatch_kv.get("latestDailySyncDate");
    console.log("Syncing any files posted since: " + lastSyncDate)

    const after = getDateToCheckAfter(lastSyncDate);
    console.log(after ? "Checking files for dates after " + after : "Checking every file");
    const [emiFiles, storedUploadTimes] = await Promise.all([getListOfEmiFiles(after), getStoredUploadTimes(after)]);

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
            const metadata: CheckpointMetadata = { updatedAt: Date.now() };
            await env.dispatch_kv.put("latestDailySyncDate", checkpoint, { metadata });
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
        (out[time] ??= []).push(item.UnitCode == "N/A"
            // a load node's initial MW is its load, so its generation (always 0) is kept as it is
            ? {
                p: item.PointOfConnectionCode,
                l: +item.LoadMegawatts,
                g: +item.GenerationMegawatts,
                c: +item.DollarsPerMegawattHour,
            }
            // a unit's generation is its initial MW (what it was generating at the start of the interval), rather
            // than what it was dispatched to generate by the end of it
            : {
                p: `${item.PointOfConnectionCode} ${item.UnitCode}`,
                l: +item.LoadMegawatts,
                g: +item.InitialMegawatts,
                c: +item.DollarsPerMegawattHour,
                m: +item.InitialMegawatts === +item.GenerationMegawatts,
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

// the date (e.g. 20261008) whose later files are checked: the last few weeks' (or every one since the last sync, when it's
// further behind), or undefined to check every file
function getDateToCheckAfter(lastSyncDate: string | null): string | undefined {
    if (!lastSyncDate || new Date().getUTCHours() === FULL_CHECK_UTC_HOUR) {
        return undefined;
    }
    const recent = new Date(Date.now() - (RECENT_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    return lastSyncDate < recent ? lastSyncDate : recent;
}

// when each stored daily file was last written, by date (e.g. 20261008)
async function getStoredUploadTimes(after: string | undefined): Promise<Map<string, number>> {
    const uploadTimes = new Map<string, number>();
    let cursor: string | undefined;

    do {
        const listing = await env.dispatch.list({ prefix: "dispatch-", startAfter: after && "dispatch-" + after, cursor });
        for (const object of listing.objects) {
            uploadTimes.set(object.key.replace("dispatch-", ""), object.uploaded.getTime());
        }
        cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);

    return uploadTimes;
}

// EMI's files for dates after the given one (or all of them), from the folders of the years they're in
async function getListOfEmiFiles(after: string | undefined): Promise<EmiDailyFile[]> {
    const folders = after ? getYearsSince(+after.slice(0, 4)).map(year => `${FOLDER}${year}/`) : [FOLDER];
    const blobs = (await Promise.all(folders.map(listEmiDatasetBlobs))).flat();

    return blobs
        .filter(blob => blob.name.endsWith("DispatchNodalPricesAndVolumes.csv"))
        .map(blob => ({
            date: blob.name.split('/').slice(-1)[0].split('_')[0],
            url: blob.url,
            lastModified: blob.lastModified,
        }))
        .filter(file => !after || file.date > after);
}

// a day's file is published the day after it, so the current year's folder is the latest one with files
function getYearsSince(year: number): number[] {
    return Array.from({ length: new Date().getUTCFullYear() - year + 1 }, (_, i) => year + i);
}
