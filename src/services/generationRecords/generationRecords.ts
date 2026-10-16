import { GeneratorDefinition } from "../../clients/generators";
import { GenerationRecord } from "../../models/generationRecord";
import { HistoricalDispatchRecord } from "../../models/historicalDispatchRecord";
import { RealTimeDispatch } from "../../models/realTimeDispatch";

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

// the live dispatch is only compared against the records once they include the daily files up to this many days
// ago, so it doesn't alert for units "beating" records that are incomplete (e.g. while the files are first read)
const MAX_DAYS_BEHIND = 7;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type NewGenerationRecord = {
    node: string;
    record: GenerationRecord;
    previous: GenerationRecord;
}

// each generating unit's generation (MW) in an interval of real time dispatch
export function getGenerationByNode(dispatch: RealTimeDispatch[]): Map<string, number> {
    return new Map(dispatch
        .filter(item => isGeneratingUnit(item.PointOfConnectionCode))
        .map(item => [item.PointOfConnectionCode, item.SPDGenerationMegawatt] as const));
}

// finds each generating unit's highest generation in a day of dispatch
export function findDailyRecords(intervals: Record<string, HistoricalDispatchRecord[]>): Record<string, GenerationRecord> {
    const records = {} as Record<string, GenerationRecord>;

    for (const time in intervals) {
        for (const record of intervals[time]) {
            const mw = +record.g;
            if (isGeneratingUnit(record.p) && mw > 0 && mw > (records[record.p]?.mw ?? 0)) {
                records[record.p] = { mw, time };
            }
        }
    }

    return records;
}

// the higher record for each node. where both are the same, the earlier one (a) is kept
export function mergeRecords(a: Record<string, GenerationRecord>, b: Record<string, GenerationRecord>): Record<string, GenerationRecord> {
    const merged = { ...a };
    for (const node in b) {
        if (!merged[node] || b[node].mw > merged[node].mw) {
            merged[node] = b[node];
        }
    }
    return merged;
}

/**
 * Compares an interval's generation against each unit's record, returning the records it beat (by node) and which
 * of them to alert for.
 *
 * Units often climb past their record over several intervals (e.g. a solar farm towards midday), so only the first
 * time a unit beats a record set on an earlier day is alerted - beating it again the same day just updates the
 * record. A unit with no record yet (e.g. one that's new) gets one without an alert.
 */
export function findNewRecords(generation: Map<string, number>, time: string, records: Record<string, GenerationRecord>) {
    const updated = {} as Record<string, GenerationRecord>;
    const newRecords = [] as NewGenerationRecord[];

    for (const [node, mw] of generation) {
        const previous = records[node];
        if (mw <= 0 || (previous && mw <= previous.mw)) {
            continue;
        }

        const record = { mw, time };
        updated[node] = record;
        if (previous && getDate(previous.time) !== getDate(time)) {
            newRecords.push({ node, record, previous });
        }
    }

    return { updated, newRecords };
}

// syncedTo is the last daily file read (e.g. 20261014), time is the interval being checked (e.g. 2026-10-16T22:00:00)
export function areRecordsUpToDate(syncedTo: string, time: string): boolean {
    const syncedToDate = `${syncedTo.slice(0, 4)}-${syncedTo.slice(4, 6)}-${syncedTo.slice(6, 8)}`;
    return Date.parse(getDate(time)) - Date.parse(syncedToDate) <= MAX_DAYS_BEHIND * ONE_DAY_IN_MS;
}

// units are named with their node, as some generators have more than one unit with the same name (e.g. Arapuni)
export function formatNewRecordsMessage(newRecords: NewGenerationRecord[], generators: GeneratorDefinition[]): string {
    const unitNames = new Map(generators.flatMap(generator => generator.units.map(unit => [unit.node, unit.name] as const)));

    return newRecords.map(({ node, record, previous }) => {
        const name = unitNames.get(node);
        const unit = name ? `*${name}* (\`${node}\`)` : `\`${node}\``;
        return `🏆 ${unit} is generating *${formatMw(record.mw)}*, a new record (previously ${formatMw(previous.mw)} at ${formatTime(previous.time)})`;
    }).join("\n");
}

// substations don't have a unit code (e.g. ALB0331), generating units do (e.g. HLY2201 HLY5)
function isGeneratingUnit(node: string): boolean {
    return node.includes(" ");
}

function formatMw(mw: number): string {
    return mw.toLocaleString("en-NZ", { maximumFractionDigits: 1 }) + " MW";
}

// 2024-03-03T18:30:00 => 6:30pm on 3 March 2024
function formatTime(time: string): string {
    const [year, month, day] = getDate(time).split("-").map(Number);
    const [hours, minutes] = time.slice(11, 16).split(":").map(Number);
    return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")}${hours < 12 ? "am" : "pm"} on ${day} ${MONTHS[month - 1]} ${year}`;
}

// 2026-10-14T22:00:00 => 2026-10-14
function getDate(time: string): string {
    return time.slice(0, 10);
}
