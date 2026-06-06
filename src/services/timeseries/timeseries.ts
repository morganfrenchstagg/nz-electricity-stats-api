import { RealTimeDispatch } from "../../models/realTimeDispatch";
import { Timeseries } from "../../models/timeseries";

const MAX_DATA_POINTS = (60 / 5) * 24 * 3;

export function generateTimeseries(existingTimeseries: Timeseries, rtdData: RealTimeDispatch[]): Timeseries {
	if(rtdData.length === 0 || existingTimeseries.data.find((item: any[]) => item[0] === rtdData[0].FiveMinuteIntervalDatetime)) {
		return existingTimeseries;
	}

	if(existingTimeseries.data.length >= MAX_DATA_POINTS){
		// todo - better logic here would be to grab the last x datapoints from each array, instead of assuming that if i'm over the max then reducing the current array by 1 will fix it.
		existingTimeseries.data.shift();
		existingTimeseries.pricing.shift();
	}

	const series = [...new Set([...rtdData.map((item: RealTimeDispatch) => item.PointOfConnectionCode), ...existingTimeseries.series])];

	const pricingRow = [] as any[];
	const row = series.map((seriesItem) => {
		const item = rtdData.find((item: RealTimeDispatch) => item.PointOfConnectionCode === seriesItem);
		pricingRow.push(item ? item.DollarsPerMegawattHour : 0);
		return item ? item.SPDGenerationMegawatt - item.SPDLoadMegawatt : 0;
	});

	const {data, pricing} = ensureRowsAreAlignedWithCurrentSeries(existingTimeseries, series);

	data.push([rtdData[0].FiveMinuteIntervalDatetime, ...row]);
	pricing.push([rtdData[0].FiveMinuteIntervalDatetime, ...pricingRow]);

	return {
		series,
		data,
		pricing
	}
}

// this ensures that the existing rows in the timeseries are aligned with the new series
// e.g if there is a case of nodes being reorganised
function ensureRowsAreAlignedWithCurrentSeries(existingTimeseries: Timeseries, newSeries: string[]): {data: any[], pricing: any[]} {
	let pricing = [] as any[];
	const data = existingTimeseries.data.map((item: any[], index: number) => {
		const row = [item[0]];
		const pricingRow = [item[0]];
		newSeries.forEach((seriesItem) => {
			const oldSeriesIndex = existingTimeseries.series.indexOf(seriesItem);
			if (oldSeriesIndex === -1) {
				// a new node has been created, therefore we need to 'backfill' a null value
				row.push(0);
				pricingRow.push(0);
			} else {
				row.push(item[oldSeriesIndex + 1]);
				pricingRow.push(existingTimeseries.pricing ? existingTimeseries.pricing[index]? existingTimeseries.pricing[index][oldSeriesIndex + 1] : 0 : 0);
			}
		});
		pricing.push(pricingRow);
		return row;
	});
	return {data, pricing};
}