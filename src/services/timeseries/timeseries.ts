import { RealTimeDispatch } from "../../models/realTimeDispatch";
import { Timeseries } from "../../models/timeseries";

const MAX_DATA_POINTS = (60 / 5) * 24 * 3;

export function generateTimeseries(existingTimeseries: Timeseries, rtdData: RealTimeDispatch[]): Timeseries {
	if(rtdData.length === 0 || existingTimeseries.data.find((item: any[]) => item[0] === rtdData[0].FiveMinuteIntervalDatetime)) {
		return existingTimeseries;
	}

	if(existingTimeseries.data.length >= MAX_DATA_POINTS){
		existingTimeseries.data.shift();
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

// this ensures that the existing rows in the timeseries are aligned with the new series
// e.g if there is a case of nodes being reorganised
function ensureRowsAreAlignedWithCurrentSeries(existingTimeseries: Timeseries, newSeries: string[]): any[] {
	const data = existingTimeseries.data.map((item: any[]) => {
		const row = [item[0]];
		newSeries.forEach((seriesItem) => {
			const oldSeriesIndex = existingTimeseries.series.indexOf(seriesItem);
			if (oldSeriesIndex === -1) {
				// a new node has been created, therefore we need to 'backfill' a null value
				row.push(null);
			} else {
				row.push(item[oldSeriesIndex + 1]);
			}
		});
		return row;
	});
	return data;
}