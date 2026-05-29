import { RealTimeDispatch } from "../../models/realTimeDispatch";
import { RealTimeDispatchDto } from "../../models/realTimeDispatchDto";

export function mapBySiteCode(rtdData: RealTimeDispatch[]): Map<string, RealTimeDispatchDto[]> {
    const rtdMap = new Map<string, RealTimeDispatchDto[]>();

    for(const item of rtdData){
		const mappedData = {
			"PointOfConnectionCode": item.PointOfConnectionCode,
			"Load": item.SPDLoadMegawatt,
			"Generation": item.SPDGenerationMegawatt,
			"Price": item.DollarsPerMegawattHour,
		}
		const siteCode = item.PointOfConnectionCode.substring(0,3);
		if(rtdMap.has(siteCode)){
			const existingItem = rtdMap.get(siteCode)!;
			rtdMap.set(siteCode, [...existingItem, mappedData]);
		} else {
			rtdMap.set(siteCode, [mappedData]);
		}
	}

    return rtdMap;
}