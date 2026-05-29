import { it, describe, expect } from "vitest";

import { mapBySiteCode } from "./mapBySiteCode";
import { RealTimeDispatch } from "../../models/realTimeDispatch";
import { RealTimeDispatchDto } from "../../models/realTimeDispatchDto";

describe("mapBySiteCode", () => {
    it("should map empty array to empty map", () => {

        const result = mapBySiteCode([]);
        expect(result).toEqual(new Map<string, RealTimeDispatchDto[]>());
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
                PointOfConnectionCode: "ABC456 GAM0",
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
        expect(result).toEqual(new Map<string, RealTimeDispatchDto[]>([
            ["ABC", [
                {
                    pointOfConnectionCode: "ABC123",
                    load: 10,
                    generation  : 5,
                    price: 100
                },
                {
                    pointOfConnectionCode: "ABC456 GAM0",
                    load: 20,
                    generation: 15,
                    price: 150
                }
            ]],
            ["DEF", [
                {
                    pointOfConnectionCode: "DEF123",
                    load: 30,
                    generation: 25,
                    price: 200
                }
            ]],
            ["GAM", [
                {
                    pointOfConnectionCode: "ABC456 GAM0",
                    load: 20,
                    generation: 15,
                    price: 150
                }
            ]]
        ]));
    });
});