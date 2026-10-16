import { env } from "cloudflare:workers";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import { calculateDailyEnergy, DISPATCH_AGGREGATES_START } from "../services/dispatchAggregation/dispatchAggregation";
import { AggregateStore, recalculateMonth, recalculateWeeks, recalculateYear } from "./aggregateStore";

export const LATEST_AGGREGATED_DATE_KEY = "latestAggregatedDispatchDate";

// stored alongside the latest aggregated date, so the api can tell when the next day's data is due
export type LatestAggregatedDateMetadata = {
    updatedAt: number; // when new days were last aggregated (ms since epoch)
}
const DATES_TO_REAGGREGATE_KEY = "dispatchDatesToReaggregate";

// caps how much work a single run does, so a backfill is spread over several runs (~50ms of CPU per day)
const MAX_DAYS_PER_RUN = 400;

// called by the daily sync when it rewrites daily files (e.g. EMI republished them), so any of those days
// that have already been aggregated are recalculated on the next run. dates are in the format 20261008
export async function queueForReaggregation(dates: string[]) {
    const lastAggregatedDate = await env.dispatch_kv.get(LATEST_AGGREGATED_DATE_KEY);
    if (!lastAggregatedDate) {
        return;
    }

    const alreadyAggregated = dates.map(toIsoDate).filter(date => DISPATCH_AGGREGATES_START <= date && date <= lastAggregatedDate);
    if (alreadyAggregated.length === 0) {
        return;
    }

    const queued = await getDatesToReaggregate();
    await env.dispatch_kv.put(DATES_TO_REAGGREGATE_KEY, JSON.stringify([...new Set([...queued, ...alreadyAggregated])].sort()));
}

export async function syncDispatchAggregates() {
    console.log("Syncing dispatch aggregates");

    const [lastAggregatedDate, lastDailySyncDate, datesToReaggregate] = await Promise.all([
        env.dispatch_kv.get(LATEST_AGGREGATED_DATE_KEY),
        env.dispatch_kv.get("latestDailySyncDate"),
        getDatesToReaggregate(),
    ]);
    console.log(`Aggregating any daily dispatch files after: ${lastAggregatedDate}, up to: ${lastDailySyncDate}, plus ${datesToReaggregate.length} day(s) to recalculate`);

    // only aggregate files the daily sync has finished with, so that if it's re-syncing older files
    // (e.g. after resetting latestDailySyncDate) the aggregates don't get ahead of it and use stale files
    if (!lastDailySyncDate) {
        console.log("Daily dispatch hasn't been synced yet, skipping");
        return;
    }

    const listing = await env.dispatch.list({
        prefix: "dispatch-",
        startAfter: lastAggregatedDate ? "dispatch-" + lastAggregatedDate.replace(/-/g, '') : undefined,
        limit: MAX_DAYS_PER_RUN,
    });

    const newDates = listing.objects
        .map(object => object.key.replace("dispatch-", ""))
        .filter(date => /^\d{8}$/.test(date) && date <= lastDailySyncDate)
        .map(toIsoDate);

    // earlier days come from metered generation instead
    const dates = [...new Set([...datesToReaggregate, ...newDates])]
        .filter(date => date >= DISPATCH_AGGREGATES_START)
        .sort()
        .slice(0, MAX_DAYS_PER_RUN);

    if (dates.length === 0) {
        console.log("No new daily dispatch files to aggregate");
        return;
    }

    // process (and checkpoint) a month at a time, so a failed run doesn't lose all of its progress
    const datesByMonth = new Map<string, string[]>();
    for (const date of dates) {
        const month = date.slice(0, 7);
        datesByMonth.set(month, [...(datesByMonth.get(month) || []), date]);
    }

    const store = new AggregateStore();
    let latestAggregatedDate = lastAggregatedDate;
    let remainingToReaggregate = datesToReaggregate;

    for (const [month, monthDates] of datesByMonth) {
        console.log(`Aggregating ${monthDates.length} day(s) in ${month}`);

        for (const date of monthDates) {
            const file = await env.dispatch.get("dispatch-" + date.replace(/-/g, ''));
            if (!file) {
                console.warn("Daily dispatch file disappeared: " + date);
                continue;
            }
            const intervals = await file.json() as Record<string, HistoricalDispatchRecord[]>;
            await store.upsert("daily", month, calculateDailyEnergy(date, intervals));
        }

        await recalculateWeeks(store, monthDates);
        await recalculateMonth(store, month);
        await recalculateYear(store, month.slice(0, 4));

        await store.flush();

        // days being recalculated are older than the checkpoint, so only move it forward
        const lastDate = monthDates[monthDates.length - 1];
        if (!latestAggregatedDate || lastDate > latestAggregatedDate) {
            latestAggregatedDate = lastDate;
            const metadata: LatestAggregatedDateMetadata = { updatedAt: Date.now() };
            await env.dispatch_kv.put(LATEST_AGGREGATED_DATE_KEY, latestAggregatedDate, { metadata });
        }
        if (remainingToReaggregate.some(date => monthDates.includes(date))) {
            remainingToReaggregate = remainingToReaggregate.filter(date => !monthDates.includes(date));
            await env.dispatch_kv.put(DATES_TO_REAGGREGATE_KEY, JSON.stringify(remainingToReaggregate));
        }
    }

    console.log("Finished syncing dispatch aggregates");
}

async function getDatesToReaggregate(): Promise<string[]> {
    const queued = await env.dispatch_kv.get(DATES_TO_REAGGREGATE_KEY);
    return queued ? JSON.parse(queued) as string[] : [];
}

// 20261008 => 2026-10-08
function toIsoDate(date: string): string {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}
