import { ApiClient } from "./api";
import { addDays, todayInNz } from "./dates";
import { getAllSubstations, isUnitNode, normaliseName } from "./nodes";
import { HvdcTimeseries } from "../models/hvdc";

export type DispatchDay = {
	series: string[];
	// [NZ time, ...net MW (generation - load) for each node in series]
	data: [string, ...number[]][];
	// [NZ time, ...$/MWh for each node in series], null before the dispatch data began
	pricing: [string, ...(number | null)[]][];
	hvdc: HvdcTimeseries;
	// whether it's from the live dispatch, as EMI hasn't published the day yet
	live: boolean;
};

// how many days the live dispatch (/v1/dispatch/recent) keeps
const LIVE_DAYS = 3;

// each day's dispatch, or for the days before the dispatch data began, its half-hourly metered generation. EMI publishes
// each day's dispatch the day after, so until then it's the live dispatch's 5-minute intervals so far
export class DispatchDays {
	private recent?: Promise<DispatchDay | null>;

	// from is the first day that'll be requested, so the live dispatch is only requested once, from then
	constructor(private api: ApiClient, private from: string) { }

	async get(date: string): Promise<DispatchDay | null> {
		const day = await this.api.get<Omit<DispatchDay, "live">>(`/v1/dispatch/${date}`);
		if (day) {
			return { ...day, live: false };
		}
		if (date < addDays(todayInNz(), -LIVE_DAYS)) {
			return null;
		}

		this.recent ??= this.api.get<DispatchDay>(`/v1/dispatch/recent?since=${addDays(this.from, -1)}T23:55:00`);
		const live = await this.recent;
		const onDate = <T extends unknown[]>(rows: T[]) => rows.filter(row => (row[0] as string).startsWith(date));
		const data = live ? onDate(live.data) : [];
		return data.length === 0 ? null : {
			series: live!.series,
			data,
			pricing: onDate(live!.pricing),
			hvdc: { series: live!.hvdc.series, data: onDate(live!.hvdc.data) },
			live: true,
		};
	}
}

// the minutes between a day's rows: 5 for the dispatch, 30 for metered generation
export function getIntervalMinutes(day: DispatchDay): number {
	if (day.data.length < 2) {
		return 5;
	}
	return Math.round((Date.parse(day.data[1][0] + "Z") - Date.parse(day.data[0][0] + "Z")) / 60000);
}

// the start of the bucket of minutes a row's NZ time is in, e.g. 2026-10-14T13:30 for 13:45 in 30 minute buckets
export function toBucket(time: string, minutes: number): string {
	if (minutes >= 24 * 60) {
		return time.slice(0, 10);
	}
	const minuteOfDay = +time.slice(11, 13) * 60 + +time.slice(14, 16);
	const start = Math.floor(minuteOfDay / minutes) * minutes;
	return `${time.slice(0, 11)}${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
}

// the node a day has prices for that's nearest to a request: the node itself, or for a site code, substation name or a
// node the day doesn't have, the highest voltage grid exit point at its site, or failing that one of its units. EMI's
// daily dispatch files leave out nodes with no generation or load, e.g. Ōtāhuhu is only OTA0221, not OTA2201
export function resolvePriceNode(request: string, series: string[]): string | null {
	const code = request.trim().toUpperCase();
	if (series.includes(code)) {
		return code;
	}
	const name = normaliseName(request);
	const site = /^[A-Z]{3}(\d{4})?$/.test(code)
		? code.slice(0, 3)
		: getAllSubstations().find(substation => normaliseName(substation.description) === name)?.siteId
		?? getAllSubstations().find(substation => normaliseName(substation.description).includes(name))?.siteId;
	if (!site) {
		return null;
	}
	const atSite = series
		.filter(node => node.startsWith(site))
		.sort((a, b) => +isUnitNode(a) - +isUnitNode(b) || +b.slice(3, 6) - +a.slice(3, 6) || a.localeCompare(b));
	return atSite[0] ?? null;
}
