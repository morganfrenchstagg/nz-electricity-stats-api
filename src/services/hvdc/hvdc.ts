import { Em6HvdcResponse, Em6Time, HvdcTimeseries } from "../../models/hvdc";

// em6's key for each series, by the name it's returned as. values are kept as em6 gives them, so the south limit is
// negative
const EM6_SERIES: Record<string, string> = {
	northFlow: "dcn_flow",
	southFlow: "dcs_flow",
	northLimit: "north_limit",
	southLimit: "south_limit",
};

// guards against caching an error body or an empty day, which would leave the recent endpoint without any HVDC
export function isValidHvdcResponse(json: any): boolean {
	const series = Object.values(EM6_SERIES).map(key => json?.data?.[key]);
	return series.every(Array.isArray) && series.some(values => values.length > 0);
}

export function toHvdcTimeseries(response: Em6HvdcResponse): HvdcTimeseries {
	const series = Object.keys(EM6_SERIES);
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

	// timestamps are all NZ times in the same format, so they sort as strings
	const data = [...rows.values()].sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
	return { series, data };
}

// in the same format as the dispatch timestamps, e.g. 2026-10-28T20:30:00
function formatEm6Time(time: Em6Time): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${time.year}-${pad(time.month + 1)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:00`;
}
