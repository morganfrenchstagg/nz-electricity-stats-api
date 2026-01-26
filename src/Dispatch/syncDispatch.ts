import { env } from "cloudflare:workers";

const emiApiUrl = 'https://emi.azure-api.net/real-time-dispatch/';

export async function syncDispatch() {
  console.log("Syncing dispatch");

  const lastSynced = await getLastSynced();

  if(isSyncNeeded(lastSynced)){
    await fetchFromEmiRtdApi(lastSynced);
  } else {
    console.log("No sync needed");
    return;
  }
}

function isSyncNeeded(lastSynced: Date){
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const diff = now.getTime() - lastSynced.getTime();
  return diff / 1000 / 60 > 5;
}

async function getLastSynced(): Promise<Date>{
  const lastSynced = await env.DB.prepare(`SELECT MAX(FiveMinuteIntervalDatetime) FROM real_time_dispatch`).first("MAX(FiveMinuteIntervalDatetime)");
  console.log("Last synced: " + new Date(lastSynced as string));
  return new Date(lastSynced as string);
}

async function fetchFromEmiRtdApi(lastSynced?: Date){
  console.log("Fetching from EMI RTD API");
  var response = await fetch(emiApiUrl, {
    headers: {
      'Ocp-Apim-Subscription-Key': env.EMI_API_KEY
    }
  })

  if(response.status === 200){
    var data = await response.json() as any[];

    console.log("Response date time: " + data[0].FiveMinuteIntervalDatetime);
    var responseDateTime = new Date(data[0].FiveMinuteIntervalDatetime);

    if(responseDateTime.getTime() <= (lastSynced?.getTime() ?? 0)){
      console.log("We are up to date with the latest data");
      return;
    }

    await processEmiRtdData(data);
  } else {
    throw new Error(`Failed to fetch from EMI RTD API: ${response.statusText}`);
  }
}

async function processEmiRtdData(data: any){
  for(var item of data){
    await env.DB.prepare(`INSERT INTO real_time_dispatch (PointOfConnectionCode, FiveMinuteIntervalDatetime, SPDLoadMegawatt, SPDGenerationMegawatt, DollarsPerMegawattHour) VALUES (?, ?, ?, ?, ?)`).bind(item.PointOfConnectionCode, item.FiveMinuteIntervalDatetime, item.SPDLoadMegawatt, item.SPDGenerationMegawatt, item.DollarsPerMegawattHour).run();
  }
  console.log("Processed " + data.length + " items");
}