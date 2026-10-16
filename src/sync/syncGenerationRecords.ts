import { env } from "cloudflare:workers";
import { getGenerators } from "../clients/generators";
import { sendSlackMessage } from "../clients/slack";
import { GenerationRecord, HistoricalGenerationRecords } from "../models/generationRecord";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { RealTimeDispatch } from "../models/realTimeDispatch";
import {
    areRecordsUpToDate,
    findDailyRecords,
    findNewRecords,
    formatNewRecordsMessage,
    getGenerationByNode,
    mergeRecords
} from "../services/generationRecords/generationRecords";

// the records from the daily dispatch files, and the ones the live dispatch has set since. they're kept apart so
// the two jobs never overwrite each other's records
const HISTORICAL_RECORDS_KEY = "historicalGenerationRecords";
const LIVE_RECORDS_KEY = "liveGenerationRecords";

// caps how much work a single run does, so the first read of every daily file is spread over several runs
const MAX_DAYS_PER_RUN = 400;

// how often progress is saved during a run, so a failed run doesn't lose all of its progress
const CHECKPOINT_EVERY_DAYS = 30;

/**
 * Finds each generating unit's record (its highest generation in an interval) in the daily dispatch files,
 * continuing from the last file it read. These are the records the live dispatch is compared against, and they also
 * pick up any records the live check missed (e.g. if a sync failed)
 */
export async function syncGenerationRecords() {
    console.log("Syncing generation records");

    const [historical, lastDailySyncDate] = await Promise.all([
        getHistoricalRecords(),
        env.dispatch_kv.get("latestDailySyncDate"),
    ]);
    console.log(`Finding generation records in daily dispatch files after: ${historical?.syncedTo}, up to: ${lastDailySyncDate}`);

    // only read files the daily sync has finished with (see syncDispatchAggregates)
    if (!lastDailySyncDate) {
        console.log("Daily dispatch hasn't been synced yet, skipping");
        return;
    }

    const listing = await env.dispatch.list({
        prefix: "dispatch-",
        startAfter: historical ? "dispatch-" + historical.syncedTo : undefined,
        limit: MAX_DAYS_PER_RUN,
    });

    const dates = listing.objects
        .map(object => object.key.replace("dispatch-", ""))
        .filter(date => /^\d{8}$/.test(date) && date <= lastDailySyncDate);

    if (dates.length === 0) {
        console.log("No new daily dispatch files to read");
        return;
    }

    let records = historical?.records ?? {};

    for (const [index, date] of dates.entries()) {
        const file = await env.dispatch.get("dispatch-" + date);
        if (file) {
            const intervals = await file.json() as Record<string, HistoricalDispatchRecord[]>;
            records = mergeRecords(records, findDailyRecords(intervals));
        } else {
            console.warn("Daily dispatch file disappeared: " + date);
        }

        if ((index + 1) % CHECKPOINT_EVERY_DAYS === 0 || index === dates.length - 1) {
            const updated: HistoricalGenerationRecords = { syncedTo: date, records };
            await env.dispatch_kv.put(HISTORICAL_RECORDS_KEY, JSON.stringify(updated));
            console.log("Found generation records up to " + date);
        }
    }

    console.log("Finished syncing generation records");
}

// compares the latest interval of real time dispatch against each unit's record, and posts any new records to Slack
export async function checkForNewGenerationRecords(dispatch: RealTimeDispatch[]) {
    const time = dispatch[0].FiveMinuteIntervalDatetime;
    const [historical, live] = await Promise.all([getHistoricalRecords(), getLiveRecords()]);

    if (!historical || !areRecordsUpToDate(historical.syncedTo, time)) {
        console.log(`Generation records only go up to ${historical?.syncedTo}, so not checking for new records yet`);
        return;
    }

    const { updated, newRecords } = findNewRecords(getGenerationByNode(dispatch), time, mergeRecords(historical.records, live));

    if (Object.keys(updated).length === 0) {
        return;
    }
    await env.dispatch_kv.put(LIVE_RECORDS_KEY, JSON.stringify({ ...live, ...updated }));

    if (newRecords.length > 0) {
        console.log("New generation records: " + newRecords.map(newRecord => newRecord.node).join(", "));
        await sendSlackMessage(formatNewRecordsMessage(newRecords, await getGenerators()));
    }
}

async function getHistoricalRecords(): Promise<HistoricalGenerationRecords | null> {
    const historical = await env.dispatch_kv.get(HISTORICAL_RECORDS_KEY);
    return historical ? JSON.parse(historical) as HistoricalGenerationRecords : null;
}

async function getLiveRecords(): Promise<Record<string, GenerationRecord>> {
    const live = await env.dispatch_kv.get(LIVE_RECORDS_KEY);
    return live ? JSON.parse(live) as Record<string, GenerationRecord> : {};
}
