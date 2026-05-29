import { it, describe, expect } from "vitest";

import { generateTimeseries } from "./timeseries";

describe("generateTimeseries", () => {
	it("empty dataset should generate a timeseries based on the input", () => {
		const exampleRtdData = [
			{
			  "PointOfConnectionCode": "ABY0111",
			  "FiveMinuteIntervalDatetime": "2026-05-29T13:30:00",
			  "FiveMinuteIntervalNumber": 1,
			  "RunDateTime": "2026-05-29T01:29:01",
			  "SPDLoadMegawatt": 2.576,
			  "SPDGenerationMegawatt": 0,
			  "DollarsPerMegawattHour": 94.08
			},
			{
			  "PointOfConnectionCode": "ARA2201 ARA0",
			  "FiveMinuteIntervalDatetime": "2026-05-29T13:30:00",
			  "FiveMinuteIntervalNumber": 1,
			  "RunDateTime": "2026-05-29T01:29:01",
			  "SPDLoadMegawatt": 0,
			  "SPDGenerationMegawatt": 72,
			  "DollarsPerMegawattHour": 100.27
			}
		  ];

		const timeseries = generateTimeseries({ series: [], data: [] }, exampleRtdData);
		expect(timeseries).toEqual({
			series: ["ABY0111", "ARA2201 ARA0"],
			data: [
				["2026-05-29T13:30:00", -2.576, 72],
			]
		});
	});

	it("existing dataset should generate a timeseries based on the input", () => {
		const existingTimeseries = {
			series: ["ABY0111", "ARA2201 ARA0"],
			data: [
				["2026-05-29T13:30:00", -2.576, 72],
			]
		};

		const exampleRtdData = [
			{
			  "PointOfConnectionCode": "ABY0111",
			  "FiveMinuteIntervalDatetime": "2026-05-29T13:35:00",
			  "FiveMinuteIntervalNumber": 1,
			  "RunDateTime": "2026-05-29T01:29:01",
			  "SPDLoadMegawatt": 3,
			  "SPDGenerationMegawatt": 0,
			  "DollarsPerMegawattHour": 94.08
			},
			{
			  "PointOfConnectionCode": "ARA2201 ARA0",
			  "FiveMinuteIntervalDatetime": "2026-05-29T13:35:00",
			  "FiveMinuteIntervalNumber": 1,
			  "RunDateTime": "2026-05-29T01:29:01",
			  "SPDLoadMegawatt": 0,
			  "SPDGenerationMegawatt": 70,
			  "DollarsPerMegawattHour": 100.27
			}
		  ];

		const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
		expect(timeseries).toEqual({
			series: ["ABY0111", "ARA2201 ARA0"],
			data: [
				["2026-05-29T13:30:00", -2.576, 72],
				["2026-05-29T13:35:00", -3, 70],
			]
		});
	});
});