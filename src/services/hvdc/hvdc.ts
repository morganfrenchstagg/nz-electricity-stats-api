import { AggregateDataPoint } from "../../models/dispatchAggregate";
import { Em6HvdcResponse, Em6Time, HvdcTimeseries } from "../../models/hvdc";
import { getTradingPeriodStarts } from "../dispatchAggregation/dispatchAggregation";
import { getColumn, getTradingDate } from "../meteredGeneration/meteredGeneration";

// em6's key for each series, by the name it's returned as. values are kept as em6 gives them, so the south limit is
// negative
const EM6_SERIES: Record<string, string> = {
	northFlow: "dcn_flow",
	southFlow: "dcs_flow",
	northLimit: "north_limit",
	southLimit: "south_limit",
};

const HVDC_SERIES = Object.keys(EM6_SERIES);

/**
 * The meters in EMI's metered HVDC flows (the HVDC_Flows dataset) each way. They've changed over the years: the link as
 * a whole (HVDC_, to 2002) or each of its poles (DCP1_ and DCP2_, 1997-2000), then each converter station's AC
 * connections (from 2003, with Pole 1's at BEN0161 and HAY1101 until 2012). Only the end the HVDC sends from is metered
 * the whole time, so each way's flow is what was exported (X) into the link there: at Benmore going north, and at
 * Haywards going south. The receiving ends' meters (e.g. HVDC_HN in 1996) are left out, as are 2002-2009's 350kV ones
 * (BEN3501 and HAY3501), which total the others
 */
const SENDING_METERS: Record<string, string[]> = {
	northFlow: ["HVDC_BN", "DCP1_BN", "DCP2_BN", "BEN0161", "BEN2201"],
	southFlow: ["HVDC_HS", "DCP1_HS", "DCP2_HS", "HAY1101", "HAY2201"],
};

// the HVDC's energy each way is stored in the HVDC aggregates as if each direction were a node generating what it sent,
// so they're totalled by week, month and year the same way as the dispatch (e.g. aggregate-hvdc-daily-2026-10)
export const HVDC_AGGREGATE_PREFIX = "aggregate-hvdc";

// guards against caching an error body or an empty day, which would leave the recent endpoint without any HVDC
export function isValidHvdcResponse(json: any): boolean {
	const series = Object.values(EM6_SERIES).map(key => json?.data?.[key]);
	return series.every(Array.isArray) && series.some(values => values.length > 0);
}

export function toHvdcTimeseries(response: Em6HvdcResponse): HvdcTimeseries {
	const series = HVDC_SERIES;
	const rows = new Map<string, (string | number | null)[]>();

	series.forEach((name, index) => {
		for (const [time, value] of response.data[EM6_SERIES[name]]) {
			const timestamp = formatEm6Time(time);
			if (!rows.has(timestamp)) {
				rows.set(timestamp, [timestamp, ...series.map(() => null)]);
			}
			rows.get(timestamp)![index + 1] = value;
		}
	});

	return { series, data: sortRows([...rows.values()]) };
}

// em6's last day by the NZ date of each half hour (e.g. 2026-10-28), so each date's half hours can be kept
export function splitHvdcByDate(timeseries: HvdcTimeseries): Map<string, HvdcTimeseries> {
	const dates = Map.groupBy(timeseries.data, row => (row[0] as string).slice(0, 10));
	return new Map([...dates].map(([date, data]) => [date, { series: timeseries.series, data }]));
}

// adds the latest half hours to what's stored for a day, replacing any stored at the same times
export function mergeHvdc(stored: HvdcTimeseries | null, latest: HvdcTimeseries): HvdcTimeseries {
	const rows = new Map(stored?.data.map(row => [row[0], row]));
	for (const row of latest.data) {
		rows.set(row[0], row);
	}
	return { series: latest.series, data: sortRows([...rows.values()]) };
}

/**
 * A month of EMI's metered HVDC flows (a month's HVDC_Flows file) by trading date, with the average MW sent each way in
 * each trading period, at the time the period starts. EMI has no transfer limits, so they're null
 */
export function toMeteredHvdcDays(records: Record<string, string>[]): Map<string, HvdcTimeseries> {
	// average MW [north, south] by trading date and trading period (1-50, since midnight)
	const days = new Map<string, Map<number, [number | null, number | null]>>();

	for (const record of records) {
		const flow = getColumn(record, "Flow_Direction") === "X"
			? HVDC_SERIES.findIndex(series => SENDING_METERS[series]?.includes(getColumn(record, "POC")))
			: -1;
		if (flow < 0) {
			continue;
		}

		const date = getTradingDate(record);
		const periods = days.get(date) ?? new Map<number, [number | null, number | null]>();
		days.set(date, periods);

		for (const column in record) {
			const period = /^TP(\d+)$/i.exec(column);
			if (!period || record[column].trim() === "") {
				continue;
			}

			const values = periods.get(+period[1]) ?? [null, null];
			// kWh over half an hour, as average MW
			values[flow] = (values[flow] ?? 0) + Number(record[column]) / 500;
			periods.set(+period[1], values);
		}
	}

	return new Map([...days].map(([date, periods]) => {
		const numbers = [...periods.keys()].sort((a, b) => a - b);
		const starts = getTradingPeriodStarts(date, Math.max(0, ...numbers));
		const data = numbers.map(period => {
			const [north, south] = periods.get(period)!;
			return [starts[period - 1], roundOrNull(north), roundOrNull(south), null, null];
		});
		return [date, { series: HVDC_SERIES, data }];
	}));
}

/**
 * A day's HVDC: EMI's metered flows once it's published the day's month, with em6's transfer limits for the same half
 * hours, or em6's half hours until then. Either can be missing, e.g. EMI's last month is about 10 days after it ends,
 * and em6's half hours are only kept from when they were first synced (see syncHvdc)
 */
export function mergeHvdcDays(metered: HvdcTimeseries | null, em6: HvdcTimeseries | null): HvdcTimeseries {
	if (!metered) {
		return em6 ?? { series: [], data: [] };
	}

	const limits = new Map(em6?.data.map(([time, , , northLimit, southLimit]) => [time, [northLimit, southLimit]]));
	return {
		series: metered.series,
		data: metered.data.map(([time, north, south]) => [time, north, south, ...limits.get(time) ?? [null, null]]),
	};
}

// the energy (MWh) the HVDC sent each way over a day, from its average MW in each half hour. em6's south flow is
// counted whatever its sign, as em6 gives the south limit as negative
export function calculateHvdcEnergy(date: string, day: HvdcTimeseries): AggregateDataPoint {
	let north = 0;
	let south = 0;
	for (const [, northFlow, southFlow] of day.data) {
		north += Number(northFlow ?? 0) / 2;
		south += Math.abs(Number(southFlow ?? 0)) / 2;
	}

	return {
		from: date,
		to: date,
		nodes: {
			northFlow: { g: round(north), l: 0 },
			southFlow: { g: round(south), l: 0 },
		},
	};
}

// timestamps are all NZ times in the same format, so they sort as strings
function sortRows(rows: (string | number | null)[][]): (string | number | null)[][] {
	return rows.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

// in the same format as the dispatch timestamps, e.g. 2026-10-28T20:30:00
function formatEm6Time(time: Em6Time): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${time.year}-${pad(time.month + 1)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:00`;
}

function roundOrNull(value: number | null): number | null {
	return value === null ? null : round(value);
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
