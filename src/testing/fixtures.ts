import { RealTimeDispatch } from "../models/realTimeDispatch";
import { PocpOutage } from "../models/pocpOutage";
import { Em6HvdcResponse } from "../models/hvdc";

export const EMI_RTD_URL = "https://emi.azure-api.net/real-time-dispatch/";
export const EMI_DATASETS_LISTING_URL = "https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list";
export const EMI_DATASETS_FILES_URL = "https://emidatasets.blob.core.windows.net/publicdata/";
export const POCP_OUTAGES_URL = "https://api.transpower.co.nz/v2/so/api/pocp/guest/outages";
export const EM6_HVDC_URL = "https://www.transpower.co.nz/em6/data/hvdc";

export type ListedBlob = {
	name: string;
	lastModified?: string; // e.g. Wed, 14 Oct 2026 01:00:00 GMT
};

// one page of an Azure blob container listing, as returned for EMI's public datasets
export function emiBlobListing(blobs: ListedBlob[], nextMarker?: string): Response {
	const blobXml = blobs.map(blob => `
		<Blob>
			<Name>${blob.name}</Name>
			<Url>${EMI_DATASETS_FILES_URL}${blob.name}</Url>
			<Properties>
				<Last-Modified>${blob.lastModified ?? "Wed, 14 Oct 2026 01:00:00 GMT"}</Last-Modified>
			</Properties>
		</Blob>`).join("");

	return new Response(`<?xml version="1.0" encoding="utf-8"?>
		<EnumerationResults ContainerName="https://emidatasets.blob.core.windows.net/publicdata">
			<Blobs>${blobXml}</Blobs>
			${nextMarker ? `<NextMarker>${nextMarker}</NextMarker>` : "<NextMarker />"}
		</EnumerationResults>`);
}

// the dates (YYYYMMDD) of the EMI dataset files downloaded, from their file names
export function downloadedDates(requests: Request[]): string[] {
	return requests
		.filter(request => request.url.startsWith(EMI_DATASETS_FILES_URL))
		.map(request => request.url.split("/").slice(-1)[0].split("_")[0]);
}

export function rtd(pointOfConnectionCode: string, generation: number, load: number, price: number, time = "2026-10-14T22:00:00"): RealTimeDispatch {
	return {
		PointOfConnectionCode: pointOfConnectionCode,
		FiveMinuteIntervalDatetime: time,
		SPDGenerationMegawatt: generation,
		SPDLoadMegawatt: load,
		DollarsPerMegawattHour: price,
	};
}

export function outage(outageBlock: string, overrides: Partial<PocpOutage> = {}): PocpOutage {
	return {
		outageBlock,
		mwattLost: 84,
		mwattRemaining: 0,
		timeStart: "2026-10-14T08:00:00Z",
		timeEnd: "2026-10-16T05:00:00Z",
		planningStatus: "CONFIRMED",
		category: "GENERATION",
		...overrides,
	} as PocpOutage;
}

// em6's HVDC data for 2 half hours on 28 October 2026 (em6 counts months from 0)
export function em6Hvdc(): Em6HvdcResponse {
	const series = (first: number, second: number) => [
		[{ day: 28, month: 9, year: 2026, hour: 20, minute: 0 }, first],
		[{ day: 28, month: 9, year: 2026, hour: 20, minute: 30 }, second],
	] as Em6HvdcResponse["data"][string];

	return {
		last_import: 1793172600,
		data: {
			dcn_flow: series(675, 638),
			dcs_flow: series(0, 0),
			north_limit: series(1200, 1200),
			south_limit: series(-648, -658),
		},
	};
}

// em6Hvdc() as it's stored and returned
export const HVDC_TIMESERIES = {
	series: ["northFlow", "southFlow", "northLimit", "southLimit"],
	data: [
		["2026-10-28T20:00:00", 675, 0, 1200, -648],
		["2026-10-28T20:30:00", 638, 0, 1200, -658],
	],
};
