import { describe, expect, it } from "vitest";

import { isValidHvdcResponse, toHvdcTimeseries } from "./hvdc";
import { em6Hvdc, HVDC_TIMESERIES } from "../../testing/fixtures";
import { Em6HvdcResponse } from "../../models/hvdc";

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
