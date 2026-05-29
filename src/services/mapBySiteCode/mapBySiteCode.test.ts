import { it, describe, expect } from "vitest";

import { mapBySiteCode } from "./mapBySiteCode";
import { RealTimeDispatch } from "../../models/realTimeDispatch";

describe("mapBySiteCode", () => {
    it("should map empty array to empty map", () => {

        const result = mapBySiteCode([]);
        expect(result).toEqual(new Map<string, any[]>());
    });

    it("should map RTD data to a map grouped by site code", () => {
        const rtdData: RealTimeDispatch[] = [
            {
                PointOfConnectionCode: "ABC123",
                FiveMinuteIntervalDatetime: "2024-01-01T00:00:00Z",
                SPDLoadMegawatt: 10,
                SPDGenerationMegawatt: 5,
                DollarsPerMegawattHour: 100
            },
            {
                PointOfConnectionCode: "ABC456",
                FiveMinuteIntervalDatetime: "2024-01-01T00:05:00Z",
                SPDLoadMegawatt: 20,
                SPDGenerationMegawatt: 15,
                DollarsPerMegawattHour: 150
            },
            {
                PointOfConnectionCode: "DEF123",
                FiveMinuteIntervalDatetime: "2024-01-01T00:10:00Z",
                SPDLoadMegawatt: 30,
                SPDGenerationMegawatt: 25,
                DollarsPerMegawattHour: 200
            }];

        const result = mapBySiteCode(rtdData);
        expect(result).toEqual(new Map<string, any[]>([
            ["ABC", [
                {
                    PointOfConnectionCode: "ABC123",
                    Load: 10,
                    Generation: 5,
                    Price: 100
                },
                {
                    PointOfConnectionCode: "ABC456",
                    Load: 20,
                    Generation: 15,
                    Price: 150
                }
            ]],
            ["DEF", [
                {
                    PointOfConnectionCode: "DEF123",
                    Load: 30,
                    Generation: 25,
                    Price: 200
                }
            ]]
        ]));
    });
});