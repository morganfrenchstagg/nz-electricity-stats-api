import { RealTimeDispatch } from "../models/realTimeDispatch";
import { Timeseries } from "../models/timeseries";

export function generateTimeseries(existingTimeseries: Timeseries, rtdData: RealTimeDispatch[]): Timeseries {
	if(rtdData.length === 0 || existingTimeseries.data.find((item: any[]) => item[0] === rtdData[0].FiveMinuteIntervalDatetime)) {
		return existingTimeseries;
	}

	const series = [...new Set([...rtdData.map((item: RealTimeDispatch) => item.PointOfConnectionCode), ...existingTimeseries.series])];

	const row = series.map((seriesItem) => {
		const item = rtdData.find((item: RealTimeDispatch) => item.PointOfConnectionCode === seriesItem);
		return item ? item.SPDGenerationMegawatt - item.SPDLoadMegawatt : null;
	});

	const data = ensureRowsAreAlignedWithCurrentSeries(existingTimeseries, series);

	data.push([rtdData[0].FiveMinuteIntervalDatetime, ...row]);

	return {
		series,
		data,
	}
}

// there may be new generators in the rtd data, so this aligns the data based on the new series
// inserting nulls where relevant
function ensureRowsAreAlignedWithCurrentSeries(existingTimeseries: Timeseries, newSeries: string[]): any[] {
	const data = existingTimeseries.data.map((item: any[]) => {
		const row = [item[0]];
		newSeries.forEach((seriesItem) => {
			const oldSeriesIndex = existingTimeseries.series.indexOf(seriesItem);
			if (oldSeriesIndex === -1) {
				row.push(null);
			} else {
				row.push(item[oldSeriesIndex + 1]);
			}
		});
		return row;
	});
	return data;
}