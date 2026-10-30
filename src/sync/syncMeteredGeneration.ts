import { env } from "cloudflare:workers";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";
import { sendSlackMessage } from "../clients/slack";
import { csvToJson } from "../services/csvToJson/csvToJson";
import { DISPATCH_AGGREGATES_START, getMonthBounds } from "../services/dispatchAggregation/dispatchAggregation";
import {
    calculateMeteredGeneration,
    METERED_DAY_PREFIX,
    METERED_GENERATION_CODES,
    MeteredGenerationCode,
    MeteredSource
} from "../services/meteredGeneration/meteredGeneration";
import { AggregateStore, recalculateMonth, recalculateWeeks, recalculateYear } from "./aggregateStore";

// where each dataset's monthly files are, e.g. 199708_Generation_MD.csv
const FOLDERS: Record<MeteredSource, string> = {
    Generation_MD: "Datasets/Wholesale/Generation/Generation_MD/",
    Embedded_generation: "Datasets/Wholesale/Metered_data/Embedded_generation/",
    Grid_import: "Datasets/Wholesale/Metered_data/Grid_import/",
};

// which monthly files have been aggregated, and with which version of meteredGenerationCodes.json
const SYNC_STATE_KEY = "meteredGenerationSync";

type SyncState = {
    codesVersion: string;
    months: Record<string, string>; // the version of the files aggregated for each month (see getFilesVersion), by month (e.g. 199708)
}

type MeteredGenerationFile = {
    source: MeteredSource;
    month: string; // YYYYMM
    url: string;
    lastModified: number;
}

// a month's Generation_MD file, and the other datasets' files any of its days are attributed from
type MonthToAggregate = {
    month: string; // YYYYMM
    files: MeteredGenerationFile[];
}

// caps how much work a single run does, so the first backfill (about 280 months) is spread over several runs. a month
// is about 50ms of CPU, well within the 30 seconds a cron that runs more than hourly gets, but most of its time is
// spent waiting on R2 (about 20 seconds a month when the run is far from the bucket). so a run stops starting new
// months after 11 minutes, leaving time to finish the last one before the next run starts 15 minutes later
const MAX_MONTHS_PER_RUN = 60;
const TIME_BUDGET_MS = 11 * 60 * 1000;

// the last month with days before the dispatch aggregates start
const LAST_MONTH = DISPATCH_AGGREGATES_START.slice(0, 7).replace("-", "");

/**
 * Aggregates EMI's metered generation (the Generation_MD dataset, from August 1997) for the days before the daily
 * dispatch files begin, so the daily, weekly, monthly and annual aggregates go back to 1997, and stores each of those
 * days by trading period (see METERED_DAY_PREFIX). Each generator's generation is attributed to a unit in
 * generators.json using meteredGenerationCodes.json, which also fills in generators Generation_MD is missing for part
 * of their history from EMI's embedded generation and grid import data.
 *
 * A month is aggregated again when EMI republishes any of its files, and every month is when the codes change, so a fix
 * to how a generator is attributed reaches all of its history. Metered generation has no load, other than generators'
 * own (e.g. their station load while they're idle), so the aggregates before then are generation only.
 */
export async function syncMeteredGeneration(codes: MeteredGenerationCode[] = METERED_GENERATION_CODES) {
    console.log("Syncing metered generation");
    const startTime = Date.now();

    const [files, state, codesVersion] = await Promise.all([getListOfFiles(codes), getSyncState(), getCodesVersion(codes)]);

    if (state && state.codesVersion !== codesVersion) {
        console.log("The metered generation codes have changed, so aggregating every month again");
    }
    const aggregated = state?.codesVersion === codesVersion ? state.months : {};

    const monthsToAggregate = getMonths(files, codes)
        .filter(({ month, files }) => month <= LAST_MONTH && aggregated[month] !== getFilesVersion(files));

    if (monthsToAggregate.length === 0) {
        console.log("No metered generation to aggregate");
        return;
    }

    const store = new AggregateStore();
    const months = { ...aggregated };
    const unlisted = new Map<string, { mwh: number; months: string[] }>();

    for (const [index, { month, files }] of monthsToAggregate.entries()) {
        if (index >= MAX_MONTHS_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
            console.log(`Stopping for this run, ${monthsToAggregate.length - index} month(s) left to aggregate`);
            break;
        }

        const records = await Promise.all(files.map(async ({ source, url }) => ({ source, records: await downloadFile(url) })));
        const { days, unlisted: monthUnlisted } = calculateMeteredGeneration(records, codes);

        const dates = [...days.keys()].filter(date => date < DISPATCH_AGGREGATES_START).sort();
        await Promise.all(dates.map(date =>
            env.dispatch.put(METERED_DAY_PREFIX + date.replace(/-/g, ""), JSON.stringify(days.get(date)!.periods))));

        for (const date of dates) {
            await store.upsert("daily", date.slice(0, 7), { from: date, to: date, nodes: days.get(date)!.energy });
        }

        // a file only has its own month's trading days
        const isoMonth = `${month.slice(0, 4)}-${month.slice(4)}`;
        await recalculateWeeks(store, dates);
        await recalculateMonth(store, isoMonth);
        await recalculateYear(store, isoMonth.slice(0, 4));
        await store.flush();

        months[month] = getFilesVersion(files);
        await env.dispatch_kv.put(SYNC_STATE_KEY, JSON.stringify({ codesVersion, months } satisfies SyncState));

        for (const [code, mwh] of monthUnlisted) {
            const existing = unlisted.get(code) ?? { mwh: 0, months: [] };
            unlisted.set(code, { mwh: existing.mwh + mwh, months: [...existing.months, month] });
        }

        console.log("Aggregated metered generation for " + month);
    }

    // their generation is left out until they're listed, which aggregates every month again
    if (unlisted.size > 0) {
        console.warn("Metered generation codes that aren't listed: " + [...unlisted.keys()].join(", "));
        await sendSlackMessage(formatUnlistedCodesMessage(unlisted));
    }

    console.log("Finished syncing metered generation");
}

export function formatUnlistedCodesMessage(unlisted: Map<string, { mwh: number; months: string[] }>): string {
    const lines = [...unlisted].map(([code, { mwh, months }]) => {
        const gwh = (mwh / 1000).toLocaleString("en-NZ", { maximumFractionDigits: 1 });
        const period = months.length === 1 ? months[0] : `${months[0]}-${months[months.length - 1]}`;
        return `• \`${code}\`: ${gwh} GWh (${period})`;
    });

    return "⚠️ EMI's metered generation has generators that aren't in meteredGenerationCodes.json, so their generation "
        + "is left out of the aggregates. Add each one with the unit it belongs to (or why it's excluded):\n"
        + lines.join("\n");
}

// the monthly files of Generation_MD, and of any other dataset a code is from
async function getListOfFiles(codes: MeteredGenerationCode[]): Promise<MeteredGenerationFile[]> {
    const sources = new Set<MeteredSource>(["Generation_MD", ...codes.map(code => code.source ?? "Generation_MD")]);

    const listings = await Promise.all([...sources].map(async source => {
        const folder = FOLDERS[source];
        const name = new RegExp(`^\\d{6}_${source}\\.csv$`);

        return (await listEmiDatasetBlobs(folder))
            .filter(blob => name.test(blob.name.slice(folder.length)))
            .map(blob => ({
                source,
                month: blob.name.slice(folder.length, folder.length + 6),
                url: blob.url,
                lastModified: blob.lastModified,
            }));
    }));

    return listings.flat();
}

// each month with a Generation_MD file, oldest first, with the other datasets' files for the month that any of its
// days are attributed from, so they're only downloaded for the months that need them
function getMonths(files: MeteredGenerationFile[], codes: MeteredGenerationCode[]): MonthToAggregate[] {
    return [...Map.groupBy(files, file => file.month)]
        .filter(([, files]) => files.some(file => file.source === "Generation_MD"))
        .map(([month, files]) => ({
            month,
            files: files.filter(file => file.source === "Generation_MD" || isAttributedFrom(file.source, month, codes)),
        }))
        .sort((a, b) => a.month.localeCompare(b.month));
}

// whether a code from the dataset attributes any of the month's (e.g. 201502) days to a unit
function isAttributedFrom(source: MeteredSource, month: string, codes: MeteredGenerationCode[]): boolean {
    const { from, to } = getMonthBounds(`${month.slice(0, 4)}-${month.slice(4)}`);
    return codes.some(code => code.source === source && code.node && (code.from ?? "") <= to && from <= (code.to ?? "9999"));
}

// when EMI last published each of a month's files, so the month is aggregated again when any of them changes
function getFilesVersion(files: MeteredGenerationFile[]): string {
    return files.map(file => `${file.source} ${file.lastModified}`).sort().join(", ");
}

async function downloadFile(url: string): Promise<Record<string, string>[]> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status}`);
    }

    // some files (e.g. late 2014 to mid 2016) pad their empty trading periods with null characters
    return csvToJson((await response.text()).replaceAll("\0", ""));
}

async function getSyncState(): Promise<SyncState | null> {
    const state = await env.dispatch_kv.get(SYNC_STATE_KEY);
    return state ? JSON.parse(state) as SyncState : null;
}

// only what changes how generation is attributed, so editing a code's note doesn't aggregate everything again
async function getCodesVersion(codes: MeteredGenerationCode[]): Promise<string> {
    const attribution = codes.map(({ code, source, node, from, to }) =>
        [code, source ?? "Generation_MD", node ?? null, from ?? null, to ?? null]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(attribution)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
