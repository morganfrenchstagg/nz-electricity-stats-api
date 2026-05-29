import { RealTimeDispatch } from "../models/realTimeDispatch";
import { Timeseries } from "../models/timeseries";

export function generateTimeseries(existingTimeseries: Timeseries, rtdData: RealTimeDispatch[]): Timeseries {
	const series = rtdData.map((item: RealTimeDispatch) => item.PointOfConnectionCode);
	const thisDispatchData = rtdData.map((item: RealTimeDispatch) => item.SPDGenerationMegawatt - item.SPDLoadMegawatt);

	return {
		series,
		data: [...existingTimeseries.data, [rtdData[0].FiveMinuteIntervalDatetime, ...thisDispatchData]],
	}
}