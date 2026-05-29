import { RealTimeDispatch } from "../models/realTimeDispatch";
import { Timeseries } from "../models/timeseries";

export function generateTimeseries(existingTimeseries: Timeseries, rtdData: RealTimeDispatch[]): Timeseries {
	const series = rtdData.map((item: RealTimeDispatch) => item.PointOfConnectionCode);
	const thisDispatchData = rtdData.map((item: RealTimeDispatch) => item.SPDGenerationMegawatt - item.SPDLoadMegawatt);

	// there may be new generators in the rtd data, so this aligns the data based on the new series
	// inserting nulls where relevant
	const data = existingTimeseries.data.map((item: any[]) => {
		const row = [item[0]];
		series.forEach((seriesItem) => {
			const oldSeriesIndex = existingTimeseries.series.indexOf(seriesItem);
			if (oldSeriesIndex === -1) {
				row.push(null);
			} else {
				row.push(item[oldSeriesIndex + 1]);
			}
		});
		return row;
	});

	data.push([rtdData[0].FiveMinuteIntervalDatetime, ...thisDispatchData]);

	return {
		series,
		data,
	}
}