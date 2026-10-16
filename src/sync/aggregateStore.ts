import { env } from "cloudflare:workers";
import { AggregateDataPoint, AggregateResolution, DispatchAggregate } from "../models/dispatchAggregate";
import {
    getAggregateKey,
    getDatesBetween,
    getIsoWeek,
    getMonthBounds,
    sumDataPoints,
    upsertDataPoint
} from "../services/dispatchAggregation/dispatchAggregation";

// weeks are rebuilt from the daily data, as a week can span two months
export async function recalculateWeeks(store: AggregateStore, dates: string[]) {
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

export async function recalculateMonth(store: AggregateStore, month: string) {
    const daily = await store.get("daily", month);
    const { from, to } = getMonthBounds(month);
    await store.upsert("monthly", month.slice(0, 4), sumDataPoints(from, to, daily.data));
}

export async function recalculateYear(store: AggregateStore, year: string) {
    const monthly = await store.get("monthly", year);
    await store.upsert("annual", "all", sumDataPoints(`${year}-01-01`, `${year}-12-31`, monthly.data));
}

// caches aggregate files in memory during a run, and only writes back the ones that changed
export class AggregateStore {
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
