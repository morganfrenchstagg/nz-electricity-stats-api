import { PointOfConnectionDto } from "../../models/pointOfConnectionDto";
import { RealTimeDispatch } from "../../models/realTimeDispatch";

export function mapByPointOfConnectionCode(rtdData: RealTimeDispatch[]): Map<string, PointOfConnectionDto> {
    const pointOfConnectionCodeMap = new Map<string, PointOfConnectionDto>();

    for (const item of rtdData) {
        pointOfConnectionCodeMap.set(item.PointOfConnectionCode, {
            load: item.SPDLoadMegawatt,
            generation: item.SPDGenerationMegawatt,
            price: item.DollarsPerMegawattHour,
        });
    }

    return pointOfConnectionCodeMap;
}
