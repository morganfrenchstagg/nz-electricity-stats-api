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
        
		putInMap(siteCode, mappedData, rtdMap);

        const generatorCode = item.PointOfConnectionCode.substring(7,10).trim();

        if(generatorCode){
            putInMap(generatorCode, mappedData, rtdMap);
        }
	}

    return rtdMap;
}

function putInMap(siteCode: string, data: RealTimeDispatchDto, map: Map<string, RealTimeDispatchDto[]>){
    if(map.has(siteCode)){
        const existingItem = map.get(siteCode)!;
        map.set(siteCode, [...existingItem, data]);
    } else {
        map.set(siteCode, [data]);
    }
}