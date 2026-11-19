import codes from "../../data/meteredGenerationCodes.json" with { type: "json" };
import { NodeEnergy } from "../../models/dispatchAggregate";
import { MeteredGenerationRecord } from "../../models/meteredGenerationRecord";
import { getTradingPeriodStarts, hoursInNzDay } from "../dispatchAggregation/dispatchAggregation";

/**
 * The EMI datasets the metered generation comes from. Generation_MD has most generators, but some embedded ones only
 * from part way through their history (e.g. Cobb is missing from 2015 to 2019), so those days come from the embedded
 * generation data instead, which Generation_MD takes its embedded generators from. Kawerau's cogeneration isn't
 * metered on its own before 2020, so its export to the grid comes from the grid import data. Generation_MD also meters
 * some units together (e.g. Huntly's Rankine units), and leaves out some of Huntly for a while (e.g. all of it in
 * September 2020), so those units come from the unit-level generation data, which has each of the larger units on its own
 */
export type MeteredSource = "Generation_MD" | "Embedded_generation" | "Grid_import" | "Unit_level_generation";

/**
 * The EMI datasets a month's metered days are read from: the ones generators are attributed from, and the grid export
 * data for the load. Grid_export has what each point of connection took from the grid (from October 1996), and
 * Grid_import what it injected (from October 2000), by the network or direct connection metered there
 */
export type MeteredDataset = MeteredSource | "Grid_export";

// the columns identifying a generator in each dataset, its point of connection then its generator, loss, network or unit code
const CODE_COLUMNS: Record<MeteredSource, [string, string]> = {
    Generation_MD: ["POC_Code", "Gen_Code"],
    Embedded_generation: ["POC", "Loss_Code"],
    Grid_import: ["POC", "Nwk_Code"],
    Unit_level_generation: ["POC", "Unit_Code"],
};

// the grid export and import data's connection types that are a generator's own rather than load: a grid-connected
// generator's (GG), whose station load isn't in the dispatch data, and an embedded generator's (EG), which the grid import
// data has a few of from 2001 to 2007. the rest are networks (GN), direct connections (GD) and embedded networks (EN)
const GENERATOR_CONNECTION_TYPES = ["GG", "EG"];

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

// each day's metered generation and load by trading period is stored as metered-YYYYMMDD, as the daily dispatch files
// are stored as dispatch-YYYYMMDD
export const METERED_DAY_PREFIX = "metered-";

// from 2009 Generation_MD numbers a day's trading periods by the half hours since midnight (46 on the day daylight
// saving starts, and 50 on the day it ends), as the other datasets always have. before then it numbered them by the
// clock, so there were always 48: the hour skipped when daylight saving starts is blank, and the hour repeated when it
// ends only appears once
const PERIODS_SINCE_MIDNIGHT_FROM = "2009-01-01";

// a month's file from one of the datasets, e.g. 199708_Generation_MD.csv
export type MeteredFile = {
    source: MeteredDataset;
    records: Record<string, string>[];
}

// a day of metered generation and load: each node's energy over the day, and its average generation and load over each
// trading period
export type MeteredDay = {
    energy: Record<string, NodeEnergy>; // MWh by node
    periods: Record<string, MeteredGenerationRecord[]>; // by when the trading period starts (see getTradingPeriodStarts)
}

// a month of metered generation and load by trading date (e.g. 1997-08-01), and generation from codes that aren't listed
// (MWh by code)
export type MeteredGeneration = {
    days: Map<string, MeteredDay>;
    unlisted: Map<string, number>;
}

/**
 * A generator's code in the metered data: its point of connection and its generator code in Generation_MD (e.g. ATI2201
 * atiamuri), loss code in the embedded generation data (e.g. STK0661 cobb), network code in the grid import data
 * (e.g. KAW0112 skog), or unit code in the unit-level generation data (e.g. HLY2201 un5). The other columns are left
 * out, as they change over time for the same generator (e.g. with its owner), and the code is lowercased as its case
 * varies too (e.g. Te_Mihi and te_mihi)
 */
export function getMeteredCode(record: Record<string, string>, source: MeteredSource = "Generation_MD"): string {
    const [pointOfConnection, generator] = CODE_COLUMNS[source];
    return `${getColumn(record, pointOfConnection)} ${getColumn(record, generator).toLowerCase()}`;
}

/**
 * Totals a month of metered generation and load by trading day and node, from one or more of the datasets' files for
 * the month. Each row of a file is a generator's metered generation, or what a network or direct connection took from
 * or injected into the grid (kWh), in each trading period of a day (46-50 of them, depending on daylight saving).
 * Generators metered at more than one point, or under more than one network code, are added together.
 *
 * Periods where a generator used more than it generated (e.g. its station load while it's idle) count as load,
 * as they do in the dispatch data.
 *
 * Each point of connection's load is a node of its own (e.g. ABY0111), as it is in the dispatch data: what it took from
 * the grid less what it injected, with the attributed generators metered behind it (e.g. Te Uku's wind farm, behind
 * TWH0331) added back, as the dispatch data has them generating at the node rather than netted from its load. Like the
 * dispatch data's, it can be below 0 while generation that isn't dispatched (e.g. Teviot, behind CYD0331) is more than
 * the load. Before October 2000 there's no grid import data, so it's only what was taken from the grid (with Kinleith's
 * embedded generation added back), and can't be below 0.
 */
export function calculateMeteredGeneration(files: MeteredFile[], codes: MeteredGenerationCode[]): MeteredGeneration {
    const codesByCode = Map.groupBy(codes, code => `${code.source ?? "Generation_MD"} ${code.code}`);
    const loadConnections = getLoadConnections(files);
    // average MW by trading date, trading period (1-50, since midnight) and node
    const generation = new Map<string, Map<number, Map<string, NodeEnergy>>>();
    const unlisted = new Map<string, number>();
    // each connection's rows of load on each day, by dataset, connection and trading date
    const loadRows = new Map<string, Map<number, number>[]>();

    for (const { source, records } of files) {
        for (const record of records) {
            const date = getTradingDate(record);
            const day = generation.get(date) ?? new Map<number, Map<string, NodeEnergy>>();
            generation.set(date, day); // so a day with nothing attributed still replaces what was there before

            if (isLoad(source, record)) {
                const periods = getTradingPeriods(record, null);
                const key = `${source} ${getConnection(record, source)} ${date}`;
                const rows = loadRows.get(key) ?? [];

                // a few direct connections are listed twice with the same values, under two retailers (e.g. BDE0111 in
                // November 2002), so they're only counted once
                if (!rows.some(row => isSamePeriods(row, periods))) {
                    loadRows.set(key, [...rows, periods]);
                    addLoad(day, getColumn(record, "POC"), periods, source === "Grid_export" ? 1 : -1);
                }
            }

            // the embedded generation data also has what's used at a generator's connection (X), which Generation_MD
            // leaves out of its embedded generators
            if (source === "Grid_export" || (source !== "Generation_MD" && getColumn(record, "Flow_Direction") !== "I")) {
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

            if (isEmbedded(source, record, loadConnections)) {
                addLoad(day, getColumn(record, CODE_COLUMNS[source][0]), periods, 1);
            }
        }
    }

    return {
        days: new Map([...generation].map(([date, day]) => [date, toMeteredDay(date, day)])),
        unlisted,
    };
}

// whether a row of the grid export or import data is a point of connection's load, rather than a generator's own connection
function isLoad(source: MeteredDataset, record: Record<string, string>): boolean {
    return (source === "Grid_export" || source === "Grid_import")
        && !GENERATOR_CONNECTION_TYPES.includes(getColumn(record, "Generation_Type"));
}

// a row's point of connection and network, e.g. KIN0112 CHHE for the Kinleith mill's own connection to the grid
function getConnection(record: Record<string, string>, source: MeteredDataset): string {
    return `${getColumn(record, source === "Generation_MD" ? "POC_Code" : "POC")} ${getColumn(record, "Nwk_Code")}`;
}

// the connections with load in the month's grid export or import data
function getLoadConnections(files: MeteredFile[]): Set<string> {
    return new Set(files.flatMap(({ source, records }) =>
        records.filter(record => isLoad(source, record)).map(record => getConnection(record, source))));
}

// whether a generator is metered behind a point of connection's load: everything in the embedded generation data, and
// the generators whose point of connection and network have load (e.g. Kinleith's cogeneration, behind the mill's
// connection, or Mokai, behind the Tuaropaki network's). the others are metered where they connect to the grid on their own
function isEmbedded(source: MeteredSource, record: Record<string, string>, loadConnections: Set<string>): boolean {
    return source === "Embedded_generation" || loadConnections.has(getConnection(record, source));
}

function isSamePeriods(a: Map<number, number>, b: Map<number, number>): boolean {
    return a.size === b.size && [...a].every(([period, kwh]) => b.get(period) === kwh);
}

// adds kWh in each trading period to (or with a sign of -1, takes it from) a point of connection's load, as average MW
function addLoad(day: Map<number, Map<string, NodeEnergy>>, pointOfConnection: string, periods: Map<number, number>, sign: 1 | -1) {
    for (const [period, kwh] of periods) {
        const nodes = day.get(period) ?? new Map<string, NodeEnergy>();
        day.set(period, nodes);

        const existing = nodes.get(pointOfConnection) ?? { g: 0, l: 0 };
        nodes.set(pointOfConnection, { g: 0, l: existing.l + sign * kwh / 500 });
    }
}

function toMeteredDay(date: string, day: Map<number, Map<string, NodeEnergy>>): MeteredDay {
    const energy = {} as Record<string, NodeEnergy>;
    const periods = {} as Record<string, MeteredGenerationRecord[]>;

    const numbers = [...day.keys()].sort((a, b) => a - b);
    const starts = getTradingPeriodStarts(date, Math.max(0, ...numbers));

    for (const period of numbers) {
        for (const [node, mw] of day.get(period)!) {
            const record = { p: node, g: round(mw.g), l: round(mw.l) };
            // the dispatch data leaves out nodes at 0, e.g. a point of connection that only injected its embedded
            // generator's generation, which is added back
            if (record.g === 0 && record.l === 0) {
                continue;
            }

            (periods[starts[period - 1]] ??= []).push(record);

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
