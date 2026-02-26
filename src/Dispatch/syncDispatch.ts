import { env } from "cloudflare:workers";
import { checkForMissingUnits } from "./missingUnits/missingUnitChecker";

const emiApiUrl = 'https://emi.azure-api.net/real-time-dispatch/';

export async function syncDispatch() {
  console.log("Syncing dispatch");

  const lastSynced = await getLastSynced();

  if(isSyncNeeded(lastSynced)){
    await fetchAndProcessDataFromEmiApi(lastSynced);
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

async function fetchDataFromEmiApi(){
  console.log("Fetching from EMI RTD API");
  var response = await fetch(emiApiUrl, {
    headers: {
      'Ocp-Apim-Subscription-Key': env.EMI_API_KEY
    }
  })
  return response;
}

async function fetchAndProcessDataFromEmiApi(lastSynced?: Date){
  const response = await fetchDataFromEmiApi();

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
  const insert = env.DB.prepare(`INSERT INTO real_time_dispatch (PointOfConnectionCode, FiveMinuteIntervalDatetime, SPDLoadMegawatt, SPDGenerationMegawatt, DollarsPerMegawattHour) VALUES (?, ?, ?, ?, ?)`);
  const batch = [];
  for(var item of data){
    const firstTradingPeriodOfTheDay = item.FiveMinuteIntervalDatetime.split("T")[1] === "00:00:00";
    if(item.SPDLoadMegawatt === 0 && item.SPDGenerationMegawatt === 0 && !firstTradingPeriodOfTheDay){
      continue;
    }
    batch.push(insert.bind(item.PointOfConnectionCode, item.FiveMinuteIntervalDatetime, item.SPDLoadMegawatt, item.SPDGenerationMegawatt, item.DollarsPerMegawattHour));
  }
  console.log("Batch size: " + batch.length);
  env.DB.batch(batch);
  console.log("Processed " + data.length + " items");
}

export async function checkForMissingUnitsToday(){
  console.log("Checking for missing units today");
  const response = await fetchDataFromEmiApi();
  if(response.status === 200){
    const data = await response.json() as any[];
    var missingUnitResponse = await checkForMissingUnits(data.map(item => item.PointOfConnectionCode) as string[]);
    if(missingUnitResponse.generation.notInDispatchList.length > 0 || 
      missingUnitResponse.substations.notInDispatchList.length > 0 || 
      missingUnitResponse.generation.notInGeneratorList.length > 0 ||
      missingUnitResponse.substations.notInSubstationList.length > 0){
        await sendMissingUnitsToSlack(missingUnitResponse);
      } else{
        console.log("No missing units");
      }
  } else {
    throw new Error(`Failed to fetch from EMI RTD API: ${response.statusText}`);
  }
}

async function sendMissingUnitsToSlack(missingUnitResponse: any){
  console.log("Sending missing units to Slack");

  var slackMessage = "*Update for " + getNZDateTime() + ":*\n";
  if(missingUnitResponse.substations.notInSubstationList.length > 0){
    slackMessage += "Missing unit in substation list: `" + missingUnitResponse.substations.notInSubstationList.join('`, `') + "`" + "\n";
  }
  if(missingUnitResponse.substations.notInDispatchList.length > 0){
    slackMessage += "Missing substation in Real Time Dispatch: `" + missingUnitResponse.substations.notInDispatchList.join('`, `') + "`" + "\n";
  }
  if(missingUnitResponse.generation.notInGeneratorList.length > 0){
    slackMessage += "Missing unit in generator list: `" + missingUnitResponse.generation.notInGeneratorList.join('`, `') + "`" + "\n";
  }
  if(missingUnitResponse.generation.notInDispatchList.length > 0){
    slackMessage += "Missing generator in Real Time Dispatch: `" + missingUnitResponse.generation.notInDispatchList.join('`, `') + "`";
  }
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: slackMessage
    })
  });
}