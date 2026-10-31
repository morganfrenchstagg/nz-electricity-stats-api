import { describe, expect, it } from "vitest";

import {
	calculateHvdcEnergy,
	isValidHvdcResponse,
	mergeHvdc,
	mergeHvdcDays,
	splitHvdcByDate,
	toHvdcTimeseries,
	toMeteredHvdcDays
} from "./hvdc";
import { em6Hvdc, HVDC_TIMESERIES } from "../../testing/fixtures";
import { Em6HvdcResponse } from "../../models/hvdc";

const SERIES = HVDC_TIMESERIES.series;

// a row of EMI's HVDC_Flows data: a meter's kWh in each of a day's trading periods (the newer files' column names)
function record(poc: string, direction: string, date: string, kwh: (number | string)[]): Record<string, string> {
	const periods = Array.from({ length: 50 }, (_, i) => [`TP${i + 1}`, String(kwh[i] ?? "")]);
	return {
		POC: poc, Nwk_Code: "TPNZ", Generation_Type: "DC", Trader: "TPNZ", Unit_Measure: "kWh",
		Flow_Direction: direction, Status: "F", Trading_Date: date, ...Object.fromEntries(periods),
	};
}

// the same kWh in every trading period of a 24 hour day
const allDay = (kwh: number) => Array(48).fill(kwh);

describe("toHvdcTimeseries", () => {
	it("returns a row for each half hour, at its NZ time, with each series' value", () => {
		expect(toHvdcTimeseries(em6Hvdc())).toEqual(HVDC_TIMESERIES);
	});

	it("pads the month, day, hour and minute, counting months from 1", () => {
		const time = { day: 1, month: 0, year: 2027, hour: 4, minute: 0 };
		const response = {
			last_import: 1798729200,
			data: { dcn_flow: [[time, 500]], dcs_flow: [[time, 0]], north_limit: [[time, 1200]], south_limit: [[time, -600]] },
		} as Em6HvdcResponse;

		expect(toHvdcTimeseries(response).data).toEqual([["2027-01-01T04:00:00", 500, 0, 1200, -600]]);
	});

	it("leaves a series' value null in the half hours em6 has none for it", () => {
		const response = em6Hvdc();
		response.data.dcs_flow = response.data.dcs_flow.slice(1);

		expect(toHvdcTimeseries(response).data).toEqual([
			["2026-10-28T20:00:00", 675, null, 1200, -648],
			["2026-10-28T20:30:00", 638, 0, 1200, -658],
		]);
	});
});

describe("isValidHvdcResponse", () => {
	it("accepts em6's HVDC data", () => {
		expect(isValidHvdcResponse(em6Hvdc())).toBe(true);
	});

	it("rejects a day without any half hours", () => {
		expect(isValidHvdcResponse({ last_import: 1793172600, data: { dcn_flow: [], dcs_flow: [], north_limit: [], south_limit: [] } })).toBe(false);
	});

	it("rejects data missing a series", () => {
		const response = em6Hvdc() as any;
		delete response.data.south_limit;

		expect(isValidHvdcResponse(response)).toBe(false);
	});

	it("rejects an error body", () => {
		expect(isValidHvdcResponse({ message: "Service Unavailable" })).toBe(false);
		expect(isValidHvdcResponse(null)).toBe(false);
	});
});

describe("toMeteredHvdcDays", () => {
	it("returns each trading period's average MW sent north from Benmore and south from Haywards", () => {
		const days = toMeteredHvdcDays([
			record("BEN2201", "X", "2026-09-01", allDay(325000)),
			record("BEN2201", "I", "2026-09-01", allDay(9000)),
			record("HAY2201", "I", "2026-09-01", allDay(315000)),
			record("HAY2201", "X", "2026-09-01", allDay(10000)),
		]);

		const day = days.get("2026-09-01")!;
		expect(day.series).toEqual(SERIES);
		expect(day.data).toHaveLength(48);
		expect(day.data[0]).toEqual(["2026-09-01T00:00:00", 650, 20, null, null]);
		expect(day.data[47]).toEqual(["2026-09-01T23:30:00", 650, 20, null, null]);
	});

	it("adds up Pole 1 and Pole 2's connections, leaving out the 350kV meters that total them", () => {
		const day = toMeteredHvdcDays([
			record("BEN0161", "X", "2005-01-01", allDay(100000)),
			record("BEN2201", "X", "2005-01-01", allDay(150000)),
			record("BEN3501", "X", "2005-01-01", allDay(250000)),
			record("HAY1101", "X", "2005-01-01", allDay(0)),
			record("HAY2201", "X", "2005-01-01", allDay(500)),
			record("HAY3501", "X", "2005-01-01", allDay(500)),
		]).get("2005-01-01")!;

		expect(day.data[0]).toEqual(["2005-01-01T00:00:00", 500, 1, null, null]);
	});

	it("reads the older files' poles, dates and column names", () => {
		const old = (poc: string, kwh: number) => {
			const { POC, Flow_Direction, Trading_Date, ...rest } = record(poc, "X", "", allDay(kwh));
			return { POC: poc, FLOW_DIRECTION: "X", TRADING_DATE: "01/10/1997", ...rest };
		};

		const days = toMeteredHvdcDays([old("DCP1_BN", 100000), old("DCP2_BN", 150000), old("DCP1_HN", 240000), old("DCP1_HS", 0), old("DCP2_HS", 0)]);

		expect([...days.keys()]).toEqual(["1997-10-01"]);
		expect(days.get("1997-10-01")!.data[0]).toEqual(["1997-10-01T00:00:00", 500, 0, null, null]);
	});

	it("numbers the trading periods from midnight on the days daylight saving starts and ends", () => {
		const days = toMeteredHvdcDays([
			record("BEN2201", "X", "2026-04-05", Array(50).fill(1000)),
			record("BEN2201", "X", "2026-09-27", Array(46).fill(1000)),
		]);

		const ends = days.get("2026-04-05")!.data.map(row => row[0]);
		expect(ends).toHaveLength(50);
		// the repeated hour's periods start at the same times as the hour before them
		expect(ends.slice(4, 8)).toEqual(["2026-04-05T02:00:00", "2026-04-05T02:30:00", "2026-04-05T02:00:00", "2026-04-05T02:30:00"]);
		expect(ends[49]).toEqual("2026-04-05T23:30:00");

		const starts = days.get("2026-09-27")!.data.map(row => row[0]);
		expect(starts).toHaveLength(46);
		expect(starts.slice(3, 5)).toEqual(["2026-09-27T01:30:00", "2026-09-27T03:00:00"]);
	});

	it("leaves a direction null in the periods none of its meters have a value for", () => {
		const day = toMeteredHvdcDays([
			record("BEN2201", "X", "2026-09-01", allDay(500)),
			record("HAY2201", "X", "2026-09-01", ["", ...allDay(500).slice(1)]),
		]).get("2026-09-01")!;

		expect(day.data[0]).toEqual(["2026-09-01T00:00:00", 1, null, null, null]);
		expect(day.data[1]).toEqual(["2026-09-01T00:30:00", 1, 1, null, null]);
	});
});

describe("splitHvdcByDate", () => {
	it("splits em6's last day into each date's half hours", () => {
		const timeseries = {
			series: SERIES,
			data: [["2026-10-28T23:30:00", 600, 0, 1200, -650], ["2026-10-29T00:00:00", 610, 0, 1200, -650]],
		};

		expect(splitHvdcByDate(timeseries)).toEqual(new Map([
			["2026-10-28", { series: SERIES, data: [timeseries.data[0]] }],
			["2026-10-29", { series: SERIES, data: [timeseries.data[1]] }],
		]));
	});
});

describe("mergeHvdc", () => {
	it("keeps the stored half hours, replacing any at the same times as the latest", () => {
		const stored = { series: SERIES, data: [["2026-10-28T20:00:00", 600, 0, 1200, -650], ["2026-10-28T20:30:00", null, 0, 1200, -650]] };
		const latest = { series: SERIES, data: [["2026-10-28T21:00:00", 620, 0, 1200, -650], ["2026-10-28T20:30:00", 610, 0, 1200, -650]] };

		expect(mergeHvdc(stored, latest).data).toEqual([
			["2026-10-28T20:00:00", 600, 0, 1200, -650],
			["2026-10-28T20:30:00", 610, 0, 1200, -650],
			["2026-10-28T21:00:00", 620, 0, 1200, -650],
		]);
	});

	it("returns the latest when nothing's stored", () => {
		expect(mergeHvdc(null, HVDC_TIMESERIES)).toEqual(HVDC_TIMESERIES);
	});
});

describe("mergeHvdcDays", () => {
	const metered = { series: SERIES, data: [["2026-10-12T00:00:00", 650, 0, null, null], ["2026-10-12T00:30:00", 640, 0, null, null]] };

	it("leaves the limits null in the half hours em6 doesn't have", () => {
		const em6 = { series: SERIES, data: [["2026-10-12T00:30:00", 630, 0, 1200, -650]] };

		expect(mergeHvdcDays(metered, em6).data).toEqual([
			["2026-10-12T00:00:00", 650, 0, null, null],
			["2026-10-12T00:30:00", 640, 0, 1200, -650],
		]);
	});

	it("is empty when there's neither", () => {
		expect(mergeHvdcDays(null, null)).toEqual({ series: [], data: [] });
	});
});

describe("calculateHvdcEnergy", () => {
	it("totals the MWh sent each way, counting em6's south flow whatever its sign", () => {
		const day = { series: SERIES, data: [["2026-10-12T00:00:00", 600, 0, 1200, -650], ["2026-10-12T00:30:00", 400, -20, 1200, -650], ["2026-10-12T01:00:00", null, 30, 1200, -650]] };

		expect(calculateHvdcEnergy("2026-10-12", day)).toEqual({
			from: "2026-10-12",
			to: "2026-10-12",
			nodes: { northFlow: { g: 500, l: 0 }, southFlow: { g: 25, l: 0 } },
		});
	});
});
