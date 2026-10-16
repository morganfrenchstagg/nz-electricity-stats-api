import codes from "../../data/meteredGenerationCodes.json" with { type: "json" };
import { NodeEnergy } from "../../models/dispatchAggregate";

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

// a day of metered generation by node, and generation from codes that aren't listed (MWh by code)
export type MeteredDailyEnergy = {
    days: Map<string, Record<string, NodeEnergy>>; // by trading date (e.g. 1997-08-01)
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
export function calculateMeteredDailyEnergy(records: Record<string, string>[], codes: MeteredGenerationCode[]): MeteredDailyEnergy {
    const codesByCode = Map.groupBy(codes, code => code.code);
    const days = new Map<string, Record<string, NodeEnergy>>();
    const unlisted = new Map<string, number>();

    for (const record of records) {
        // the column is Trading_date in older files and Trading_Date in newer ones
        const date = record.Trading_date ?? record.Trading_Date;
        const nodes = days.get(date) ?? {};
        days.set(date, nodes); // so a day with nothing attributed still replaces what was there before

        const { generation, load } = sumTradingPeriods(record);
        if (generation === 0 && load === 0) {
            continue;
        }

        const code = getMeteredCode(record);
        const match = codesByCode.get(code)?.find(entry => (entry.from ?? "") <= date && date <= (entry.to ?? "9999"));

        if (!match) {
            unlisted.set(code, (unlisted.get(code) ?? 0) + generation - load);
        } else if (match.node) {
            const existing = nodes[match.node] ?? { g: 0, l: 0 };
            nodes[match.node] = { g: existing.g + generation, l: existing.l + load };
        }
    }

    for (const nodes of days.values()) {
        for (const node in nodes) {
            nodes[node] = { g: round(nodes[node].g), l: round(nodes[node].l) };
        }
    }

    return { days, unlisted };
}

// MWh from the trading period columns (TP1-TP50), which are kWh
function sumTradingPeriods(record: Record<string, string>): { generation: number; load: number } {
    let generation = 0;
    let load = 0;

    for (const column in record) {
        const kwh = /^TP\d+$/.test(column) && record[column] !== "" ? +record[column] : 0;
        if (kwh > 0) {
            generation += kwh / 1000;
        } else if (kwh < 0) {
            load -= kwh / 1000;
        }
    }

    return { generation, load };
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}
