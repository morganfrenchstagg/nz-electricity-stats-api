import { env } from "cloudflare:workers";
import { getGenerators } from "./generators";

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

function getNZDateTime(): Date{
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
}

function isSyncNeeded(lastSynced: Date){
  const now = getNZDateTime();
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
    await checkForMissingUnits(data[0].FiveMinuteIntervalDatetime);
  } else {
    throw new Error(`Failed to fetch from EMI RTD API: ${response.statusText}`);
  }
}

async function processEmiRtdData(data: any){
  const insert = env.DB.prepare(`INSERT INTO real_time_dispatch (PointOfConnectionCode, FiveMinuteIntervalDatetime, SPDLoadMegawatt, SPDGenerationMegawatt, DollarsPerMegawattHour) VALUES (?, ?, ?, ?, ?)`);
  const batch = [];
  for(var item of data){
    if(item.SPDLoadMegawatt === 0 && item.SPDGenerationMegawatt === 0){
      continue;
    }
    batch.push(insert.bind(item.PointOfConnectionCode, item.FiveMinuteIntervalDatetime, item.SPDLoadMegawatt, item.SPDGenerationMegawatt, item.DollarsPerMegawattHour));
  }
  console.log("Batch size: " + batch.length);
  env.DB.batch(batch);
  console.log("Processed " + data.length + " items");
}

async function checkForMissingUnits(lastSynced: string){
  const generators = await getGenerators();
  const dispatchList = await env.DB.prepare(`SELECT DISTINCT PointOfConnectionCode FROM real_time_dispatch WHERE FiveMinuteIntervalDatetime = ?`).bind(lastSynced).all();
  const dispatchListResult = dispatchList.results.map(dispatch => dispatch.PointOfConnectionCode).filter(unit => (unit as string).split(' ').length > 1);

  const unitsUnaccountedForInDispatchList = dispatchListResult;

  for(const generator of generators){
    for(const unit of generator.units){
      if(dispatchListResult.includes(unit.node)){
        unitsUnaccountedForInDispatchList.splice(unitsUnaccountedForInDispatchList.indexOf(unit.node), 1);
      }
    }
  }

  if(unitsUnaccountedForInDispatchList.length > 0){
    console.log("Missing units: " + unitsUnaccountedForInDispatchList.join(', '));
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: "Missing units: `" + unitsUnaccountedForInDispatchList.join('`, `') + "`"
      })
    });
  }
}