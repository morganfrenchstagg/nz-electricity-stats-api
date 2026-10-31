import { env } from "cloudflare:workers";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";
import { HvdcTimeseries } from "../models/hvdc";
import { csvToJson } from "../services/csvToJson/csvToJson";
import { getMonthBounds } from "../services/dispatchAggregation/dispatchAggregation";
import { calculateHvdcEnergy, HVDC_AGGREGATE_PREFIX, toMeteredHvdcDays } from "../services/hvdc/hvdc";
import { AggregateStore, recalculateMonth, recalculateWeeks, recalculateYear } from "./aggregateStore";
import { EM6_HVDC_DAY_PREFIX } from "./syncHvdc";

// each month's file, e.g. 199708_HVDC_flows.csv
const FOLDER = "Datasets/Wholesale/Metered_data/HVDC_Flows/";

// EMI's metered flows on each trading date (e.g. hvdc-metered-19970801)
export const METERED_HVDC_DAY_PREFIX = "hvdc-metered-";

// the last date of the latest month of EMI's metered flows that's been aggregated, so the aggregates api can tell when a
// period's HVDC has stopped changing
export const LATEST_METERED_HVDC_DATE_KEY = "latestMeteredHvdcDate";

// when EMI last published each month's file that's been aggregated (epoch ms), by month (e.g. 199708)
const SYNC_STATE_KEY = "meteredHvdcSync";

// EMI's flows start in October 1996, but the aggregates only go back to the metered generation's first month (see
// syncMeteredGeneration), so a year's HVDC doesn't cover more of it than its generation does
const FIRST_MONTH = "199708";

// a month is a small file and about 30 days to store, so the first backfill (about 350 months) takes a few runs at most.
// a run stops starting new months after this long, well within the 15 minutes a cron trigger gets
const TIME_BUDGET_MS = 10 * 60 * 1000;

type MeteredHvdcFile = {
    month: string; // YYYYMM
    url: string;
    lastModified: number;
}

/**
 * Stores EMI's metered HVDC flows (the HVDC_Flows dataset) for each day, and totals the energy sent each way by day, week,
 * month and year in the HVDC aggregates (see HVDC_AGGREGATE_PREFIX). A month is aggregated again when EMI republishes it.
 *
 * EMI publishes each month about 10 days after it ends, so the days since its latest month are aggregated from em6's
 * half hours (see syncHvdc) until it does, every run, as em6 adds to them (today is the energy so far)
 */
export async function syncHvdcHistory() {
    console.log("Syncing HVDC history");
    const startTime = Date.now();

    const [files, aggregated, latestDate] = await Promise.all([
        getListOfFiles(),
        getSyncState(),
        env.dispatch_kv.get(LATEST_METERED_HVDC_DATE_KEY),
    ]);

    const monthsToAggregate = files.filter(file => file.month >= FIRST_MONTH && aggregated[file.month] !== file.lastModified);
    const store = new AggregateStore(HVDC_AGGREGATE_PREFIX);
    let latest = latestDate;

    for (const [index, { month, url, lastModified }] of monthsToAggregate.entries()) {
        if (Date.now() - startTime > TIME_BUDGET_MS) {
            console.log(`Stopping for this run, ${monthsToAggregate.length - index} month(s) left to aggregate`);
            break;
        }

        const days = toMeteredHvdcDays(await downloadFile(url));
        const dates = [...days.keys()].sort();
        await Promise.all(dates.map(date =>
            env.dispatch.put(METERED_HVDC_DAY_PREFIX + date.replace(/-/g, ""), JSON.stringify(days.get(date)))));

        for (const date of dates) {
            await store.upsert("daily", date.slice(0, 7), calculateHvdcEnergy(date, days.get(date)!));
        }

        // a file only has its own month's trading days
        const isoMonth = `${month.slice(0, 4)}-${month.slice(4)}`;
        await recalculateWeeks(store, dates);
        await recalculateMonth(store, isoMonth);
        await recalculateYear(store, isoMonth.slice(0, 4));
        await store.flush();

        aggregated[month] = lastModified;
        await env.dispatch_kv.put(SYNC_STATE_KEY, JSON.stringify(aggregated));

        // republished months are older than the latest, so only move it forward
        const lastDate = getMonthBounds(isoMonth).to;
        if (!latest || lastDate > latest) {
            latest = lastDate;
            await env.dispatch_kv.put(LATEST_METERED_HVDC_DATE_KEY, latest);
        }

        console.log("Aggregated metered HVDC for " + month);
    }

    await aggregateEm6Days(store, latest);

    console.log("Finished syncing HVDC history");
}

// the days after EMI's latest month, from em6's half hours. they're replaced once EMI publishes their month
async function aggregateEm6Days(store: AggregateStore, latestMeteredDate: string | null) {
    const listing = await env.dispatch.list({
        prefix: EM6_HVDC_DAY_PREFIX,
        startAfter: latestMeteredDate ? EM6_HVDC_DAY_PREFIX + latestMeteredDate.replace(/-/g, "") : undefined,
    });
    const keys = listing.objects.map(object => object.key);
    if (keys.length === 0) {
        return;
    }

    const dates = [] as string[];
    for (const key of keys) {
        const file = await env.dispatch.get(key);
        if (!file) {
            continue;
        }
        const date = toIsoDate(key.slice(EM6_HVDC_DAY_PREFIX.length));
        await store.upsert("daily", date.slice(0, 7), calculateHvdcEnergy(date, await file.json() as HvdcTimeseries));
        dates.push(date);
    }

    await recalculateWeeks(store, dates);
    for (const month of new Set(dates.map(date => date.slice(0, 7)))) {
        await recalculateMonth(store, month);
    }
    for (const year of new Set(dates.map(date => date.slice(0, 4)))) {
        await recalculateYear(store, year);
    }
    await store.flush();

    console.log(`Aggregated ${dates.length} day(s) of HVDC from em6`);
}

// oldest first, so the latest date moves forward as the backfill goes
async function getListOfFiles(): Promise<MeteredHvdcFile[]> {
    const name = /^\d{6}_HVDC_flows\.csv$/;

    return (await listEmiDatasetBlobs(FOLDER))
        .filter(blob => name.test(blob.name.slice(FOLDER.length)))
        .map(blob => ({ month: blob.name.slice(FOLDER.length, FOLDER.length + 6), url: blob.url, lastModified: blob.lastModified }))
        .sort((a, b) => a.month.localeCompare(b.month));
}

async function downloadFile(url: string): Promise<Record<string, string>[]> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status}`);
    }
    return csvToJson(await response.text());
}

async function getSyncState(): Promise<Record<string, number>> {
    const state = await env.dispatch_kv.get(SYNC_STATE_KEY);
    return state ? JSON.parse(state) as Record<string, number> : {};
}

// 20261008 => 2026-10-08
function toIsoDate(date: string): string {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}
