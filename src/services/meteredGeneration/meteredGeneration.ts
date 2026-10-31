import codes from "../../data/meteredGenerationCodes.json" with { type: "json" };
import { NodeEnergy } from "../../models/dispatchAggregate";
import { MeteredGenerationRecord } from "../../models/meteredGenerationRecord";
import { getTradingPeriodStarts, hoursInNzDay } from "../dispatchAggregation/dispatchAggregation";

/**
 * The EMI datasets the metered generation comes from. Generation_MD has most generators, but some embedded ones only
 * from part way through their history (e.g. Cobb is missing from 2015 to 2019), so those days come from the embedded
 * generation data instead, which Generation_MD takes its embedded generators from. Kawerau's cogeneration isn't
 * metered on its own before 2020, so its export to the grid comes from the grid import data
 */
export type MeteredSource = "Generation_MD" | "Embedded_generation" | "Grid_import";

// the columns identifying a generator in each dataset, its point of connection then its generator, loss or network code
const CODE_COLUMNS: Record<MeteredSource, [string, string]> = {
    Generation_MD: ["POC_Code", "Gen_Code"],
    Embedded_generation: ["POC", "Loss_Code"],
    Grid_import: ["POC", "Nwk_Code"],
};

/**
 * How a generator in EMI's metered generation data is attributed to a unit in generators.json.
 *
 * The metered data identifies generators differently to the dispatch data (e.g. "HLY2201 huntly_e3p" rather than
 * "HLY2201 HLY5"), so every Generation_MD code with generation before the dispatch data began is listed in
 * meteredGenerationCodes.json, either with the node it's attributed to or why it's excluded. Generation from a code
 * that isn't listed is left out of the aggregates and reported (see syncMeteredGeneration). The other datasets have
 * plenty of generators that are already in Generation_MD or aren't dispatched, so only the codes listed are read from them.
 */
export type MeteredGenerationCode = {
    code: string; // see getMeteredCode, e.g. ATI2201 atiamuri
    source?: MeteredSource; // the dataset it's in, Generation_MD if not given
    node?: string; // the unit it's attributed to, e.g. ATI2201 ATI0
    excluded?: string; // why it's left out, in place of a node (e.g. it isn't in the dispatch data)
    from?: string; // the first trading date it applies to, if it's attributed to different units over time
    to?: string; // the last trading date it applies to
    note?: string;
}

// JSON imports type each source as a string, so the tests check they're each one of the datasets
export const METERED_GENERATION_CODES = codes as MeteredGenerationCode[];

// each day's metered generation by trading period is stored as metered-YYYYMMDD, as the daily dispatch files are
// stored as dispatch-YYYYMMDD
export const METERED_DAY_PREFIX = "metered-";

// from 2009 Generation_MD numbers a day's trading periods by the half hours since midnight (46 on the day daylight
// saving starts, and 50 on the day it ends), as the other datasets always have. before then it numbered them by the
// clock, so there were always 48: the hour skipped when daylight saving starts is blank, and the hour repeated when it
// ends only appears once
const PERIODS_SINCE_MIDNIGHT_FROM = "2009-01-01";

// a month's file from one of the datasets, e.g. 199708_Generation_MD.csv
export type MeteredFile = {
    source: MeteredSource;
    records: Record<string, string>[];
}

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
 * A generator's code in the metered data: its point of connection and its generator code in Generation_MD (e.g. ATI2201
 * atiamuri), loss code in the embedded generation data (e.g. STK0661 cobb), or network code in the grid import data
 * (e.g. KAW0112 skog). The other columns are left out, as they change over time for the same generator (e.g. with its
 * owner), and the code is lowercased as its case varies too (e.g. Te_Mihi and te_mihi)
 */
export function getMeteredCode(record: Record<string, string>, source: MeteredSource = "Generation_MD"): string {
    const [pointOfConnection, generator] = CODE_COLUMNS[source];
    return `${getColumn(record, pointOfConnection)} ${getColumn(record, generator).toLowerCase()}`;
}

/**
 * Totals a month of metered generation by trading day and node, from one or more of the datasets' files for the
 * month. Each row of a file is a generator's metered generation (kWh) in each trading period of a day (46-50 of them,
 * depending on daylight saving). Generators metered at more than one point, or under more than one network code, are
 * added together.
 *
 * Periods where a generator used more than it generated (e.g. its station load while it's idle) count as load,
 * as they do in the dispatch data.
 */
export function calculateMeteredGeneration(files: MeteredFile[], codes: MeteredGenerationCode[]): MeteredGeneration {
    const codesByCode = Map.groupBy(codes, code => `${code.source ?? "Generation_MD"} ${code.code}`);
    // average MW by trading date, trading period (1-50, since midnight) and node
    const generation = new Map<string, Map<number, Map<string, NodeEnergy>>>();
    const unlisted = new Map<string, number>();

    for (const { source, records } of files) {
        for (const record of records) {
            const date = getTradingDate(record);
            const day = generation.get(date) ?? new Map<number, Map<string, NodeEnergy>>();
            generation.set(date, day); // so a day with nothing attributed still replaces what was there before

            // the embedded generation data also has what's used at a generator's connection (X), which Generation_MD
            // leaves out of its embedded generators
            if (source !== "Generation_MD" && getColumn(record, "Flow_Direction") !== "I") {
                continue;
            }

            const periods = getTradingPeriods(record, source === "Generation_MD" && date < PERIODS_SINCE_MIDNIGHT_FROM ? date : null);
            if (periods.size === 0) {
                continue;
            }

            const code = getMeteredCode(record, source);
            const match = codesByCode.get(`${source} ${code}`)?.find(entry => (entry.from ?? "") <= date && date <= (entry.to ?? "9999"));

            if (!match) {
                if (source === "Generation_MD") {
                    unlisted.set(code, (unlisted.get(code) ?? 0) + [...periods.values()].reduce((sum, kwh) => sum + kwh / 1000, 0));
                }
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
    const starts = getTradingPeriodStarts(date, Math.max(0, ...numbers));

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

// the trading periods (TP1-TP50) a generator generated or used anything in, with their kWh by the period's number since
// midnight. clockDate is the trading date when the record numbers them by the clock instead (see PERIODS_SINCE_MIDNIGHT_FROM)
function getTradingPeriods(record: Record<string, string>, clockDate: string | null): Map<number, number> {
    const periods = new Map<number, number>();
    const hours = clockDate ? hoursInNzDay(clockDate) : 24;

    for (const column in record) {
        const period = /^TP(\d+)$/.exec(column);
        // blank periods are 0, and the few NULL ones (in February and March 2015's embedded generation) are NaN
        const kwh = period ? Number(record[column]) : 0;
        if (kwh) {
            periods.set(toPeriodSinceMidnight(+period![1], hours), kwh);
        }
    }

    return periods;
}

// a period numbered by the clock, on a day with the given hours, as its number since midnight. the clock skips 02:00-02:59
// (TP5-6) when daylight saving starts, and has 02:00-02:59 only once when it ends, so periods from 03:00 (TP7) move
function toPeriodSinceMidnight(clockPeriod: number, hours: number): number {
    return clockPeriod < 7 ? clockPeriod : clockPeriod + (hours - 24) * 2;
}

// e.g. 1997-08-01. older files of the embedded generation and grid import data have dates as dd/mm/yyyy
export function getTradingDate(record: Record<string, string>): string {
    const date = getColumn(record, "Trading_Date");
    const [day, month, year] = date.split("/");
    return year ? `${year}-${month}-${day}` : date;
}

// a column's value, as its name's case varies between files over the years (e.g. Trading_date, Trading_Date and TRADING_DATE)
export function getColumn(record: Record<string, string>, name: string): string {
    if (name in record) {
        return record[name];
    }
    const lowercase = name.toLowerCase();
    return Object.entries(record).find(([column]) => column.toLowerCase() === lowercase)?.[1] ?? "";
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}
