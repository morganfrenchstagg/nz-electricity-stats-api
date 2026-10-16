import { env } from "cloudflare:workers";
import { listEmiDatasetBlobs } from "../clients/emiDatasets";
import { sendSlackMessage } from "../clients/slack";
import { csvToJson } from "../services/csvToJson/csvToJson";
import { DISPATCH_AGGREGATES_START } from "../services/dispatchAggregation/dispatchAggregation";
import {
    calculateMeteredGeneration,
    METERED_DAY_PREFIX,
    METERED_GENERATION_CODES,
    MeteredGenerationCode
} from "../services/meteredGeneration/meteredGeneration";
import { AggregateStore, recalculateMonth, recalculateWeeks, recalculateYear } from "./aggregateStore";

const FOLDER = "Datasets/Wholesale/Generation/Generation_MD/";

// which monthly files have been aggregated, and with which version of meteredGenerationCodes.json
const SYNC_STATE_KEY = "meteredGenerationSync";

type SyncState = {
    codesVersion: string;
    months: Record<string, number>; // when EMI last published each file aggregated (ms since epoch), by month (e.g. 199708)
}

type MeteredGenerationFile = {
    month: string; // YYYYMM
    url: string;
    lastModified: number;
}

// caps how much work a single run does, so the first backfill (about 280 months) is spread over several runs.
// a month is about 50ms of CPU, and the run stops starting new months once it's used its time
const MAX_MONTHS_PER_RUN = 60;
const TIME_BUDGET_MS = 3 * 60 * 1000;

// the last month with days before the dispatch aggregates start
const LAST_MONTH = DISPATCH_AGGREGATES_START.slice(0, 7).replace("-", "");

/**
 * Aggregates EMI's metered generation (the Generation_MD dataset, from August 1997) for the days before the daily
 * dispatch files begin, so the daily, weekly, monthly and annual aggregates go back to 1997, and stores each of those
 * days by trading period (see METERED_DAY_PREFIX). Each generator's generation is attributed to a unit in
 * generators.json using meteredGenerationCodes.json.
 *
 * A month is aggregated again when EMI republishes its file, and every month is when the codes change, so a fix to
 * how a generator is attributed reaches all of its history. Metered generation has no load, other than generators'
 * own (e.g. their station load while they're idle), so the aggregates before then are generation only.
 */
export async function syncMeteredGeneration(codes: MeteredGenerationCode[] = METERED_GENERATION_CODES) {
    console.log("Syncing metered generation");
    const startTime = Date.now();

    const [files, state, codesVersion] = await Promise.all([getListOfFiles(), getSyncState(), getCodesVersion(codes)]);

    if (state && state.codesVersion !== codesVersion) {
        console.log("The metered generation codes have changed, so aggregating every month again");
    }
    const aggregated = state?.codesVersion === codesVersion ? state.months : {};

    const filesToAggregate = files
        .filter(file => file.month <= LAST_MONTH && aggregated[file.month] !== file.lastModified)
        .sort((a, b) => a.month.localeCompare(b.month));

    if (filesToAggregate.length === 0) {
        console.log("No metered generation to aggregate");
        return;
    }

    const store = new AggregateStore();
    const months = { ...aggregated };
    const unlisted = new Map<string, { mwh: number; months: string[] }>();

    for (const [index, file] of filesToAggregate.entries()) {
        if (index >= MAX_MONTHS_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
            console.log(`Stopping for this run, ${filesToAggregate.length - index} month(s) left to aggregate`);
            break;
        }

        const { days, unlisted: monthUnlisted } = calculateMeteredGeneration(await downloadFile(file.url), codes);

        const dates = [...days.keys()].filter(date => date < DISPATCH_AGGREGATES_START).sort();
        await Promise.all(dates.map(date =>
            env.dispatch.put(METERED_DAY_PREFIX + date.replace(/-/g, ""), JSON.stringify(days.get(date)!.periods))));

        for (const date of dates) {
            await store.upsert("daily", date.slice(0, 7), { from: date, to: date, nodes: days.get(date)!.energy });
        }

        // a file only has its own month's trading days
        const month = `${file.month.slice(0, 4)}-${file.month.slice(4)}`;
        await recalculateWeeks(store, dates);
        await recalculateMonth(store, month);
        await recalculateYear(store, month.slice(0, 4));
        await store.flush();

        months[file.month] = file.lastModified;
        await env.dispatch_kv.put(SYNC_STATE_KEY, JSON.stringify({ codesVersion, months } satisfies SyncState));

        for (const [code, mwh] of monthUnlisted) {
            const existing = unlisted.get(code) ?? { mwh: 0, months: [] };
            unlisted.set(code, { mwh: existing.mwh + mwh, months: [...existing.months, file.month] });
        }

        console.log("Aggregated metered generation for " + file.month);
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

async function getListOfFiles(): Promise<MeteredGenerationFile[]> {
    const blobs = await listEmiDatasetBlobs(FOLDER);

    return blobs
        .filter(blob => /^\d{6}_Generation_MD\.csv$/.test(blob.name.slice(FOLDER.length)))
        .map(blob => ({
            month: blob.name.slice(FOLDER.length, FOLDER.length + 6),
            url: blob.url,
            lastModified: blob.lastModified,
        }));
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
    const attribution = codes.map(({ code, node, from, to }) => [code, node ?? null, from ?? null, to ?? null]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(attribution)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
