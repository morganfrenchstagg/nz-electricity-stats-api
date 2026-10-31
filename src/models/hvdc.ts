// a time in NZ. the month is counted from 0, as in JavaScript (October is 9)
export type Em6Time = {
	day: number;
	month: number;
	year: number;
	hour: number;
	minute: number;
}

// em6's HVDC data (https://www.transpower.co.nz/em6/data/hvdc): the last day's flows and transfer limits (MW) in each
// half hour, by series (e.g. dcn_flow)
export type Em6HvdcResponse = {
	last_import: number; // s since epoch
	data: Record<string, [Em6Time, number][]>;
}

// a row for each half hour, with its NZ time then the value (MW) of each series, or null where there's none (e.g. em6
// missed one, or the limits for EMI's metered flows)
export type HvdcTimeseries = {
	series: string[];
	data: (string | number | null)[][];
}
