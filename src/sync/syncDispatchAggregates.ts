import { env } from "cloudflare:workers";
import { AggregateDataPoint, AggregateResolution, DispatchAggregate } from "../models/dispatchAggregate";
import { HistoricalDispatchRecord } from "../models/historicalDispatchRecord";
import {
    calculateDailyEnergy,
    getAggregateKey,
    getDatesBetween,
    getIsoWeek,
    getMonthBounds,
    sumDataPoints,
    upsertDataPoint
} from "../services/dispatchAggregation/dispatchAggregation";

export const LATEST_AGGREGATED_DATE_KEY = "latestAggregatedDispatchDate";
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

    const alreadyAggregated = dates.map(toIsoDate).filter(date => date <= lastAggregatedDate);
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

    const dates = [...new Set([...datesToReaggregate, ...newDates])].sort().slice(0, MAX_DAYS_PER_RUN);

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
            await env.dispatch_kv.put(LATEST_AGGREGATED_DATE_KEY, latestAggregatedDate);
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

// weeks are rebuilt from the daily data, as a week can span two months
async function recalculateWeeks(store: AggregateStore, dates: string[]) {
    const weeks = new Map(dates.map(date => getIsoWeek(date)).map(week => [week.from, week]));

    for (const week of weeks.values()) {
        const days = [];
        for (const date of getDatesBetween(week.from, week.to)) {
            const daily = await store.get("daily", date.slice(0, 7));
            const day = daily.data.find(item => item.from === date);
            if (day) {
                days.push(day);
            }
        }
        await store.upsert("weekly", week.year, sumDataPoints(week.from, week.to, days));
    }
}

async function recalculateMonth(store: AggregateStore, month: string) {
    const daily = await store.get("daily", month);
    const { from, to } = getMonthBounds(month);
    await store.upsert("monthly", month.slice(0, 4), sumDataPoints(from, to, daily.data));
}

async function recalculateYear(store: AggregateStore, year: string) {
    const monthly = await store.get("monthly", year);
    await store.upsert("annual", "all", sumDataPoints(`${year}-01-01`, `${year}-12-31`, monthly.data));
}

// caches aggregate files in memory during a run, and only writes back the ones that changed
class AggregateStore {
    private files = new Map<string, DispatchAggregate>();
    private changed = new Set<string>();

    async get(resolution: AggregateResolution, period: string): Promise<DispatchAggregate> {
        const key = getAggregateKey(resolution, period);
        let aggregate = this.files.get(key);
        if (!aggregate) {
            const file = await env.dispatch.get(key);
            aggregate = file ? await file.json() as DispatchAggregate : { data: [] };
            this.files.set(key, aggregate);
        }
        return aggregate;
    }

    async upsert(resolution: AggregateResolution, period: string, dataPoint: AggregateDataPoint) {
        const aggregate = await this.get(resolution, period);
        const key = getAggregateKey(resolution, period);
        this.files.set(key, upsertDataPoint(aggregate, dataPoint));
        this.changed.add(key);
    }

    async flush() {
        for (const key of this.changed) {
            await env.dispatch.put(key, JSON.stringify(this.files.get(key)));
        }
        this.changed.clear();
    }
}
