import codes from "../../data/meteredGenerationCodes.json" with { type: "json" };
import { NodeEnergy } from "../../models/dispatchAggregate";
import { MeteredGenerationRecord } from "../../models/meteredGenerationRecord";
import { getTradingPeriodStarts } from "../dispatchAggregation/dispatchAggregation";

/**
 * How a generator in EMI's metered generation data (Generation_MD) is attributed to a unit in generators.json.
 *
 * The metered data identifies generators differently to the dispatch data (e.g. "HLY2201 huntly_e3p" rather than
 * "HLY2201 HLY5"), so every code with generation before the dispatch data began is listed in
 * meteredGenerationCodes.json, either with the node it's attributed to or why it's excluded. Generation from a code
 * that isn't listed is left out of the aggregates and reported (see syncMeteredGeneration).
 */
export type MeteredGenerationCode = {
    code: string; // see getMeteredCode, e.g. ATI2201 atiamuri
    node?: string; // the unit it's attributed to, e.g. ATI2201 ATI0
    excluded?: string; // why it's left out, in place of a node (e.g. it isn't in the dispatch data)
    from?: string; // the first trading date it applies to, if it's attributed to different units over time
    to?: string; // the last trading date it applies to
    note?: string;
}

export const METERED_GENERATION_CODES: MeteredGenerationCode[] = codes;

// each day's metered generation by trading period is stored as metered-YYYYMMDD, as the daily dispatch files are
// stored as dispatch-YYYYMMDD
export const METERED_DAY_PREFIX = "metered-";

// from 2009 EMI numbers a day's trading periods by the half hours since midnight (46 on the day daylight saving starts,
// and 50 on the day it ends). before then it numbered them by the clock, so there were always 48: the hour skipped when
// daylight saving starts is blank, and the hour repeated when it ends only appears once
const PERIODS_SINCE_MIDNIGHT_FROM = "2009-01-01";

// a day of metered generation: each node's energy over the day, and its average generation over each trading period
export type MeteredDay = {
    energy: Record<string, NodeEnergy>; // MWh by node
    periods: Record<string, MeteredGenerationRecord[]>; // by when the trading period starts (see getTradingPeriodStarts)
}

// a month of metered generation by trading date (e.g. 1997-08-01), and generation from codes that aren't listed (MWh by code)
export type MeteredGeneration = {
    days: Map<string, MeteredDay>;
    unlisted: Map<string, number>;
}

/**
 * A generator's code in the metered data: its point of connection and generator code, e.g. ATI2201 atiamuri. The
 * site and network codes are left out, as they change over time for the same generator (e.g. with its owner), and
 * the generator code is lowercased as its case varies too (e.g. Te_Mihi and te_mihi)
 */
export function getMeteredCode(record: Record<string, string>): string {
    return `${record.POC_Code} ${record.Gen_Code.toLowerCase()}`;
}

/**
 * Totals a month of metered generation by trading day and node. Each row of the file is a generator's metered
 * generation (kWh) in each trading period of a day (46-50 of them, depending on daylight saving). Generators metered
 * at more than one point, or under more than one network code, are added together.
 *
 * Periods where a generator used more than it generated (e.g. its station load while it's idle) count as load,
 * as they do in the dispatch data.
 */
export function calculateMeteredGeneration(records: Record<string, string>[], codes: MeteredGenerationCode[]): MeteredGeneration {
    const codesByCode = Map.groupBy(codes, code => code.code);
    // average MW by trading date, trading period (1-50) and node
    const generation = new Map<string, Map<number, Map<string, NodeEnergy>>>();
    const unlisted = new Map<string, number>();

    for (const record of records) {
        // the column is Trading_date in older files and Trading_Date in newer ones
        const date = record.Trading_date ?? record.Trading_Date;
        const day = generation.get(date) ?? new Map<number, Map<string, NodeEnergy>>();
        generation.set(date, day); // so a day with nothing attributed still replaces what was there before

        const periods = getTradingPeriods(record);
        if (periods.size === 0) {
            continue;
        }

        const code = getMeteredCode(record);
        const match = codesByCode.get(code)?.find(entry => (entry.from ?? "") <= date && date <= (entry.to ?? "9999"));

        if (!match) {
            unlisted.set(code, (unlisted.get(code) ?? 0) + [...periods.values()].reduce((sum, kwh) => sum + kwh / 1000, 0));
            continue;
        }
        if (!match.node) {
            continue;
        }

        for (const [period, kwh] of periods) {
            const nodes = day.get(period) ?? new Map<string, NodeEnergy>();
            day.set(period, nodes);

            // kWh over half an hour, as average MW
            const mw = kwh / 500;
            const existing = nodes.get(match.node) ?? { g: 0, l: 0 };
            nodes.set(match.node, mw > 0 ? { g: existing.g + mw, l: existing.l } : { g: existing.g, l: existing.l - mw });
        }
    }

    return {
        days: new Map([...generation].map(([date, day]) => [date, toMeteredDay(date, day)])),
        unlisted,
    };
}

function toMeteredDay(date: string, day: Map<number, Map<string, NodeEnergy>>): MeteredDay {
    const energy = {} as Record<string, NodeEnergy>;
    const periods = {} as Record<string, MeteredGenerationRecord[]>;

    const numbers = [...day.keys()].sort((a, b) => a - b);
    const starts = date < PERIODS_SINCE_MIDNIGHT_FROM
        ? getClockPeriodStarts(date)
        : getTradingPeriodStarts(date, Math.max(0, ...numbers));

    for (const period of numbers) {
        for (const [node, mw] of day.get(period)!) {
            (periods[starts[period - 1]] ??= []).push({ p: node, g: round(mw.g), l: round(mw.l) });

            const existing = energy[node] ?? { g: 0, l: 0 };
            energy[node] = { g: existing.g + mw.g / 2, l: existing.l + mw.l / 2 };
        }
    }

    for (const node in energy) {
        energy[node] = { g: round(energy[node].g), l: round(energy[node].l) };
    }

    return { energy, periods };
}

// e.g. 1997-08-01T00:00:00, 1997-08-01T00:30:00 ... 1997-08-01T23:30:00
function getClockPeriodStarts(date: string): string[] {
    return Array.from({ length: 48 }, (_, period) =>
        `${date}T${String(Math.floor(period / 2)).padStart(2, "0")}:${period % 2 === 0 ? "00" : "30"}:00`);
}

// the trading periods (TP1-TP50) a generator generated or used anything in, with their kWh by period number
function getTradingPeriods(record: Record<string, string>): Map<number, number> {
    const periods = new Map<number, number>();

    for (const column in record) {
        const period = /^TP(\d+)$/.exec(column);
        const kwh = period && record[column] !== "" ? +record[column] : 0;
        if (kwh !== 0) {
            periods.set(+period![1], kwh);
        }
    }

    return periods;
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}
