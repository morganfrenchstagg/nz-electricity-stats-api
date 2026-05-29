import { parseDocument } from "htmlparser2";
import { getElementsByTagName, getText } from "domutils";
import { env } from "cloudflare:workers";

export async function syncDailyDispatch(){
    console.log("Syncing daily dispatch");

    const filesToDownload = await getListOfFilesToDownload();
    const latestFile = await getLatestObjectKeyFromBucket();

    console.log("Latest file in bucket: " + latestFile + "\n");

    const datesToDownload = latestFile ? filesToDownload
        .filter(date => date.split('/').slice(-1)[0].split('_')[0] > latestFile.split('-')[1]) : filesToDownload;

    if(datesToDownload.length === 0){
        console.log("No new files to download");
        return;
    }

    for(const file of datesToDownload){
        console.log("Downloading file: " + file);
        const data = await downloadFileAndParse(file);
        const date = file.split('/').slice(-1)[0].split('_')[0];
        await env.dispatch.put("dispatch-" + date, JSON.stringify(data));
        console.log("Finished downloading file: " + file + "\n");
    }

    console.log("Finished syncing daily dispatch");
}

async function getLatestObjectKeyFromBucket(){
    const result = await env.dispatch.list({
        prefix: "dispatch-"
    });
    
    let allObjects = [...result.objects];
    while(result.truncated){
        const nextResult = await env.dispatch.list({
            prefix: "dispatch-",
            cursor: result.cursor,
        });
        allObjects = [...allObjects, ...nextResult.objects];
    }

    const names = allObjects
        .sort((a, b) => new Date(b.uploaded) > new Date(a.uploaded) ? 1 : -1);

    return names[0]?.key;
}

async function downloadFileAndParse(url: string){
    const response = await fetch(url);
    const text = await response.text();

    const data = csvToJson(text);

	let out = {} as Record<string, any[]>;

	for(const item of data as any[]){
        const time = item.IntervalDateTime.split('.')[0];
		out[time] = [...(out[time] || []), {
			p: item.PointOfConnectionCode + (item.UnitCode == "N/A" ? "" : ` ${item.UnitCode}`),
			l: item.LoadMegawatts,
			g: item.GenerationMegawatts,
			c: item.DollarsPerMegawattHour,
		}]
	}

    return out;
}

function csvToJson(csv: string): Record<string, string>[] {
	const lines = csv.trim().split('\n');
	if (lines.length < 2) return [];

	const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

	return lines.slice(1).map(line => {
		const values = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
		return headers.reduce((obj, header, i) => {
			obj[header] = (values[i] || '').trim().replace(/^"|"$/g, '');
			return obj;
		}, {} as Record<string, string>);
	});
}

async function getListOfFilesToDownload(){
    const response = await fetch("https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/");

    const data = await response.text();

    const xmlDoc = parseDocument(data, { xmlMode: true, decodeEntities: true });
    const blobs = getElementsByTagName("Blob", xmlDoc);

    const filesToDownload: string[] = [];

    for(let i = 0; i < blobs.length; i++){
        const blob = blobs[i];
        const name = getText(getElementsByTagName("Name", blob)[0]) || "";
        if(name.endsWith("DispatchNodalPricesAndVolumes.csv")){
            filesToDownload.push(getText(getElementsByTagName("Url", blob)[0]));
        }
    }

    return filesToDownload;
}