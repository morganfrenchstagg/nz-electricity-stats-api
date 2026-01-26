import * as htmlparser2 from "htmlparser2";
import * as domutils from "domutils";
import Papa from "papaparse";
import { env } from "cloudflare:workers";

async function getFiles() {
	const response = await fetch("https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/BidsAndOffers/Offers");
	const xmlDocument = htmlparser2.parseDocument(await response.text(), {
		xmlMode: true,
	});

	const nameElements = domutils.getElementsByTagName("Url", xmlDocument);
	const files = nameElements
		.map((el) => domutils.textContent(el))
		.filter((el) => el.endsWith(".csv"));

	return files;
}

async function filterOfferFiles(files: string[]) {
	const cutoff = new Date("2026-01-23");

	return files.filter((file) => {
		const dateStr = file.split("/")[9].split("_")[0];
		const date = new Date(dateStr.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"));
		return date.getTime() > cutoff.getTime();
	});
}

async function downloadFileAndSaveToDb(fileUrl: string) {
	console.log(`Downloading file: ${fileUrl}`);

	const response = await fetch(fileUrl);

	console.log('Downloaded - now converting to text');
	const text = await response.text();

	console.log('Now parsing');

	Papa.parse<Record<string, string>>(text, {
		header: false,
		skipEmptyLines: true,
		step: async (row: any) => {
			await saveRowToDb(row.data);
		}
	});
}

async function saveRowToDb(file: any) {
	// todo - save file to db
	const formatted = {
		TradingDate: file[0],
		TradingPeriod: file[1],
		Site: '',
		ParticipantCode: file[2],
		PointOfConnection: file[3],
		Unit: file[4],
		ProductType: file[5],
		ProductClass: file[6],
		ReserveType: file[7],
		ProductDescription: file[8],
		UTCSubmissionDate: file[9],
		UTCSubmissionTime: file[10],
		SubmissionOrder: file[11],
		IsLatestYesNo: file[12],
		Tranche: file[13],
		MaximumRampUpMegawattsPerHour: file[14],
		MaximumRampDownMegawattsPerHour: file[15],
		PartiallyLoadedSpinningReservePercent: file[16],
		MaximumOutputMegawatts: file[17],
		ForecastOfGenerationPotentialMegawatts: file[18],
		Megawatts: file[19],
		DollarsPerMegawattHour: file[20]
	}

	if (formatted.IsLatestYesNo === 'Y' && formatted.ProductClass === 'Injection' && formatted.ProductType === 'Energy') {
		console.log(`Saving row PointOfConnection: ${formatted.PointOfConnection}`);
		const result = await env.DB.prepare("INSERT INTO offers (TradingDate, TradingPeriod, Site, ParticipantCode, PointOfConnection, Unit, ProductType, ProductClass, ReserveType, ProductDescription, UTCSubmissionDate, UTCSubmissionTime, SubmissionOrder, IsLatestYesNo, Tranche, MaximumRampUpMegawattsPerHour, MaximumRampDownMegawattsPerHour, PartiallyLoadedSpinningReservePercent, MaximumOutputMegawatts, ForecastOfGenerationPotentialMegawatts, Megawatts, DollarsPerMegawattHour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.bind(formatted.TradingDate, formatted.TradingPeriod, formatted.Site, formatted.ParticipantCode, formatted.PointOfConnection, formatted.Unit, formatted.ProductType, formatted.ProductClass, formatted.ReserveType, formatted.ProductDescription, formatted.UTCSubmissionDate, formatted.UTCSubmissionTime, formatted.SubmissionOrder, formatted.IsLatestYesNo, formatted.Tranche, formatted.MaximumRampUpMegawattsPerHour, formatted.MaximumRampDownMegawattsPerHour, formatted.PartiallyLoadedSpinningReservePercent, formatted.MaximumOutputMegawatts, formatted.ForecastOfGenerationPotentialMegawatts, formatted.Megawatts, formatted.DollarsPerMegawattHour)
			.run();

		console.log(JSON.stringify(result));

		if (!result.success) {
			console.error(`Failed to save row to db: ${JSON.stringify(formatted)}`);
		}
	}
}

async function downloadAndSaveOfferFiles(files: string[]) {
	for (const file of files) {
		await downloadFileAndSaveToDb(file);
	}
}

async function getFilesToDownload() {
	const allOfferFiles = await getFiles();
	const filteredOfferFiles = await filterOfferFiles(allOfferFiles);
	console.log(`Found ${filteredOfferFiles.length} files to download`);
	return filteredOfferFiles;
}

export async function syncOffers() {
	console.log("Syncing offers");

	const fileUrls = await getFilesToDownload();
	await downloadAndSaveOfferFiles(fileUrls);

	console.log("Offers synced");
}