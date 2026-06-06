import { it, describe, expect } from "vitest";

import { generateTimeseries } from "./timeseries";
import { RealTimeDispatch } from "../../models/realTimeDispatch";

describe("generateTimeseries", () => {
  it("empty dataset should generate a timeseries based on the input", () => {
    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:30:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 2.576,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:30:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 72,
        DollarsPerMegawattHour: 100.27,
      },
    ];

    const timeseries = generateTimeseries(
      { series: [], data: [], pricing: [] },
      exampleRtdData,
    );
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [["2026-05-29T13:30:00", -2.576, 72]],
      pricing: [["2026-05-29T13:30:00", 94.08, 100.27]]
    });
  });

  it("existing dataset should generate a timeseries based on the input", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [["2026-05-29T13:30:00", -2.576, 72]],
      pricing: [["2026-05-29T13:30:00", 5, 10]]
    };

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 70,
        DollarsPerMegawattHour: 100.27,
      },
    ];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [
        ["2026-05-29T13:30:00", -2.576, 72],
        ["2026-05-29T13:35:00", -3, 70],
      ],
      pricing: [
        ["2026-05-29T13:30:00", 5, 10],
        ["2026-05-29T13:35:00", 94.08, 100.27]
      ]
    });
  });

  it("existing dataset should generate a timeseries based on the input + new node", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [["2026-05-29T13:30:00", -2.576, 72]],
      pricing: [["2026-05-29T13:30:00", 5, 10]]
    };

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 70,
        DollarsPerMegawattHour: 100.27,
      },
      {
        PointOfConnectionCode: "BRB0331 RUK99",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 8.82,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 111.5,
      },
    ];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0", "BRB0331 RUK99"],
      data: [
        ["2026-05-29T13:30:00", -2.576, 72, 0],
        ["2026-05-29T13:35:00", -3, 70, -8.82],
      ],
      pricing: [
        ["2026-05-29T13:30:00", 5, 10, 0],
        ["2026-05-29T13:35:00", 94.08, 100.27, 111.5]
      ]
    });
  });

  it("existing dataset should generate a timeseries based on the input + new node in different order", () => {
    // this is unlikely to happen based on my observation of the api behaviour, but testing this edge case just in case
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0", "BRB0331 RUK99"],
      data: [["2026-05-29T13:30:00", -2.576, 72, -1]],
      pricing: [["2026-05-29T13:30:00", 0.01, 100, 12]],
    };

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "BRB0331 RUK99",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 8.82,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 111.5,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 70,
        DollarsPerMegawattHour: 100.27,
      },
    ];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "BRB0331 RUK99", "ARA2201 ARA0"],
      data: [
        ["2026-05-29T13:30:00", -2.576, -1, 72],
        ["2026-05-29T13:35:00", -3, -8.82, 70],
      ],
      pricing: [
        ["2026-05-29T13:30:00", 0.01, 12, 100],
        ["2026-05-29T13:35:00", 94.08, 111.5, 100.27],
      ],
    });
  });

  it("existing dataset should generate the same timeseries if it already contains this timestamp", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [["2026-05-29T13:30:00", -2.576, 72]],
      pricing: []
    };

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:30:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:30:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 70,
        DollarsPerMegawattHour: 100.27,
      },
    ];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [
        ["2026-05-29T13:30:00", -2.576, 72],
      ],
      pricing: []
    });
  });

  it("existing dataset should generate the same timeseries if rtd input is empty", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [["2026-05-29T13:30:00", -2.576, 72]],
      pricing: [],
    };

    const exampleRtdData = [] as RealTimeDispatch[];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [
        ["2026-05-29T13:30:00", -2.576, 72],
      ],
      pricing: []
    });
  });

  it("existing dataset should generate a timeseries based on the input + removed node", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0", "BRB0331 RUK99"],
      data: [["2026-05-29T13:30:00", -2.576, 72, -8.82]],
      pricing: []
    };

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 70,
        DollarsPerMegawattHour: 100.27,
      },
    ];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0", "BRB0331 RUK99"],
      data: [
        ["2026-05-29T13:30:00", -2.576, 72, -8.82],
        ["2026-05-29T13:35:00", -3, 70, 0],
      ],
      pricing: [
        ["2026-05-29T13:30:00", 0, 0, 0],
        ["2026-05-29T13:35:00", 94.08, 100.27, 0],
      ]
    });
  });

  it("should drop off oldest timestamp if there are more than 864 entries (3 days worth of 5 min interval data)", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0"],
      data: Array.from({ length: 864 }, (_, i) => [`2026-05-29T${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}:00`, -2.576, 72]),
      pricing: Array.from({ length: 864 }, (_, i) => [`${i}:00`, i, i]),
    };

    expect(existingTimeseries.data[0][0]).toBe("2026-05-29T00:00:00");

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-07-01T13:30:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-30T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      }];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries.data.length).toBe(864);
    expect(timeseries.data[0][0]).toBe("2026-05-29T00:05:00");
    expect(timeseries.data[863][0]).toBe("2026-07-01T13:30:00");

    expect(timeseries.pricing[862]).toStrictEqual([
      "2026-05-29T71:55:00",
      863,
      863
    ])

    expect(timeseries.pricing[863]).toStrictEqual([
      "2026-07-01T13:30:00",
      94.08,
      0
    ])
  });

  // todo - no pricing data available
  it("should add pricing data if none already existed", () => {
    const existingTimeseries = {
      series: ["ABY0111", "ARA2201 ARA0"],
      data: [["2026-05-29T13:30:00", -2.576, 72]],
      pricing: []
    };

    const exampleRtdData = [
      {
        PointOfConnectionCode: "ABY0111",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 3,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 94.08,
      },
      {
        PointOfConnectionCode: "ARA2201 ARA0",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 0,
        SPDGenerationMegawatt: 70,
        DollarsPerMegawattHour: 100.27,
      },
      {
        PointOfConnectionCode: "BRB0331 RUK99",
        FiveMinuteIntervalDatetime: "2026-05-29T13:35:00",
        FiveMinuteIntervalNumber: 1,
        RunDateTime: "2026-05-29T01:29:01",
        SPDLoadMegawatt: 8.82,
        SPDGenerationMegawatt: 0,
        DollarsPerMegawattHour: 111.5,
      },
    ];

    const timeseries = generateTimeseries(existingTimeseries, exampleRtdData);
    expect(timeseries).toEqual({
      series: ["ABY0111", "ARA2201 ARA0", "BRB0331 RUK99"],
      data: [
        ["2026-05-29T13:30:00", -2.576, 72, 0],
        ["2026-05-29T13:35:00", -3, 70, -8.82],
      ],
      pricing: [
        ["2026-05-29T13:30:00", 0, 0, 0],
        ["2026-05-29T13:35:00", 94.08, 100.27, 111.5]
      ]
    });
  })
});
