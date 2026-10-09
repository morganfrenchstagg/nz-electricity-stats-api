import { AggregateDataPoint, AggregateResolution, DispatchAggregate, DispatchAggregateTimeseries, NodeEnergy } from "../../models/dispatchAggregate";
import { HistoricalDispatchRecord } from "../../models/historicalDispatchRecord";

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

const nzDateTimeFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Auckland",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
});

/**
 * Calculates the energy (MWh) generated/consumed by each node over a trading day.
 *
 * The daily dispatch files have two kinds of missing data:
 * - whole intervals missing from the file (gaps) - these are filled by averaging the intervals we do have
 * - a node missing from an interval that other nodes are present in - RTD omits nodes that are at zero, so these count as 0MW
 *
 * Some intervals contain more than one RTD run (and on the day daylight saving ends, the repeated hour
 * shares the same timestamp because the stored timestamps don't have a UTC offset), so each interval is
 * weighted by the number of runs it contains.
 */
export function calculateDailyEnergy(date: string, intervals: Record<string, HistoricalDispatchRecord[]>): AggregateDataPoint {
    const generation = new Map<string, number>();
    const load = new Map<string, number>();
    let samples = 0;

    for (const timestamp in intervals) {
        const runsByNode = new Map<string, number>();

        for (const record of intervals[timestamp]) {
            generation.set(record.p, (generation.get(record.p) ?? 0) + +record.g);
            load.set(record.p, (load.get(record.p) ?? 0) + +record.l);
            runsByNode.set(record.p, (runsByNode.get(record.p) ?? 0) + 1);
        }

        let runs = 0;
        for (const count of runsByNode.values()) {
            runs = Math.max(runs, count);
        }
        samples += runs;
    }

    const hours = hoursInNzDay(date);
    const nodes = {} as Record<string, NodeEnergy>;

    if (samples > 0) {
        for (const [node, totalGeneration] of generation) {
            nodes[node] = {
                g: round(totalGeneration / samples * hours),
                l: round(load.get(node)! / samples * hours),
            };
        }
    }

    return {
        from: date,
        to: date,
        nodes,
    };
}

export function sumDataPoints(from: string, to: string, dataPoints: AggregateDataPoint[]): AggregateDataPoint {
    const nodes = {} as Record<string, NodeEnergy>;

    for (const dataPoint of dataPoints) {
        for (const node in dataPoint.nodes) {
            const existing = nodes[node] ?? { g: 0, l: 0 };
            nodes[node] = {
                g: existing.g + dataPoint.nodes[node].g,
                l: existing.l + dataPoint.nodes[node].l,
            };
        }
    }

    for (const node in nodes) {
        nodes[node] = { g: round(nodes[node].g), l: round(nodes[node].l) };
    }

    return { from, to, nodes };
}

// replaces the data point for the same period (if there is one), keeping the data points in order
export function upsertDataPoint(aggregate: DispatchAggregate, dataPoint: AggregateDataPoint): DispatchAggregate {
    const data = aggregate.data.filter(item => item.from !== dataPoint.from);
    data.push(dataPoint);
    data.sort((a, b) => a.from.localeCompare(b.from));
    return { data };
}

// converts a stored aggregate to the same shape as the other dispatch timeseries. nodePrefixes optionally
// limits the series to nodes starting with any of them (e.g. HLY2201 for all of Huntly's units)
export function toTimeseries(aggregate: DispatchAggregate, nodePrefixes: string[] = []): DispatchAggregateTimeseries {
    const nodes = new Set<string>();
    for (const dataPoint of aggregate.data) {
        for (const node in dataPoint.nodes) {
            nodes.add(node);
        }
    }

    const series = [...nodes]
        .filter(node => nodePrefixes.length === 0 || nodePrefixes.some(prefix => node.startsWith(prefix)))
        .sort();

    // a node with no data for a period didn't generate or consume anything, so is 0
    const data = aggregate.data.map(dataPoint => [
        dataPoint.from,
        ...series.map(node => dataPoint.nodes[node] ? round(dataPoint.nodes[node].g - dataPoint.nodes[node].l) : 0),
    ]);

    return { series, data };
}

export function getAggregateKey(resolution: AggregateResolution, period: string): string {
    return resolution === "annual" ? "aggregate-annual" : `aggregate-${resolution}-${period}`;
}

// the number of hours in a NZ trading day: 23 when daylight saving starts, 25 when it ends, otherwise 24
export function hoursInNzDay(date: string): number {
    // 12:00 UTC is 00:00/01:00 the following day in NZ, which is always before the 02:00/03:00 daylight saving changeover
    const middayUtc = parseDate(date) + ONE_DAY_IN_MS / 2;
    const startOffset = getNzOffsetMinutes(middayUtc - ONE_DAY_IN_MS);
    const endOffset = getNzOffsetMinutes(middayUtc);
    return 24 + (startOffset - endOffset) / 60;
}

function getNzOffsetMinutes(instant: number): number {
    const parts = nzDateTimeFormat.formatToParts(new Date(instant));
    const get = (type: Intl.DateTimeFormatPartTypes) => +parts.find(part => part.type === type)!.value;
    const nzWallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return (nzWallClockAsUtc - instant) / 60000;
}

// ISO 8601 week (Monday to Sunday) - weeks that span new year belong to the year that contains their Thursday
export function getIsoWeek(date: string): { year: string; from: string; to: string } {
    const day = parseDate(date);
    const daysSinceMonday = (new Date(day).getUTCDay() + 6) % 7;
    const monday = day - daysSinceMonday * ONE_DAY_IN_MS;
    const thursday = monday + 3 * ONE_DAY_IN_MS;
    const year = new Date(thursday).getUTCFullYear();
    const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / ONE_DAY_IN_MS / 7) + 1;

    return {
        year: `${year}`,
        from: formatDate(monday),
        to: formatDate(monday + 6 * ONE_DAY_IN_MS),
    };
}

// month is in the format 2026-10
export function getMonthBounds(month: string): { from: string; to: string } {
    const [year, monthNumber] = month.split("-").map(Number);
    return {
        from: `${month}-01`,
        to: formatDate(Date.UTC(year, monthNumber, 0)),
    };
}

export function getDatesBetween(from: string, to: string): string[] {
    const dates = [] as string[];
    for (let day = parseDate(from); day <= parseDate(to); day += ONE_DAY_IN_MS) {
        dates.push(formatDate(day));
    }
    return dates;
}

// dates are in the format 2026-10-08, and are treated as calendar dates (no timezone)
function parseDate(date: string): number {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
}

function formatDate(epochMs: number): string {
    return new Date(epochMs).toISOString().split("T")[0];
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}
