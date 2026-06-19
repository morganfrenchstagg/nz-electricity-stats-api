import { env } from "cloudflare:workers";
import { checkForMissingUnits } from "../services/missingUnits/missingUnitChecker";
import { fetchDataFromEmiApi } from "../clients/emiApi";
import { generateTimeseries } from "../services/timeseries/timeseries";
import { getOutageListFromPocp } from "../clients/pocpApi";
import { mapOutagesByUnit } from "../services/outageMapping/outageMapper";
import { getGenerators } from "../clients/generators";
import { Timeseries } from "../models/timeseries";

export async function syncDispatch() {
  console.log("Syncing dispatch");
  const lastUpdated = await env.dispatch_kv.get("latestDispatchTime");
  console.log("Last updated dispatch time: " + lastUpdated);
  const lastUpdatedDate = lastUpdated ? new Date(JSON.parse(lastUpdated)) : null;

  const now = getNZDateTime();

  const diffMs = lastUpdatedDate ? now.getTime() - lastUpdatedDate.getTime() : Infinity;
  const diffMinutes = diffMs / 1000 / 60;

  if (lastUpdatedDate && diffMinutes <= 5) {
    console.log(`skipping sync`);
    return;
  }

  const response = await fetchDataFromEmiApi();
  if (response.status === 200) {
    const data = await response.json() as any[];
    const lastUpdatedRtd = data[0].FiveMinuteIntervalDatetime;

    console.log("Latest dispatch time from EMI RTD API: " + lastUpdatedRtd);

    if (`"${lastUpdatedRtd}"` === lastUpdated) {
      console.log("Data is up to date, skipping writing to R2");
      return;
    }

    const existingTimeseries = await env.dispatch.get("timeseries");

    const existingTimeseriesJson = (existingTimeseries ? await existingTimeseries.json() : { series: [], data: [] }) as Timeseries;

    const timeseries = await generateTimeseries(existingTimeseriesJson, data);
    await env.dispatch.put("timeseries", JSON.stringify(timeseries));
    await env.dispatch_kv.put("latestDispatchTime", JSON.stringify(lastUpdatedRtd));
    await env.dispatch_kv.put("latestDispatch", JSON.stringify(data))

    await checkForMissingUnitsAndNotify(data);
  }

  const outageList = await getOutageListFromPocp();
  // todo - handle if pocp returns an error or is down, we don't want to overwrite the existing outage data with an empty list
  const generators = await getGenerators();
  const outagesByUnit = mapOutagesByUnit(outageList, generators);
  await env.dispatch_kv.put("latestOutages", JSON.stringify(outagesByUnit));
}

function getNZDateTime(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
}

async function checkForMissingUnitsAndNotify(lastDispatch: any[]) {
  var missingUnitResponse = await checkForMissingUnits(lastDispatch.map(item => item.PointOfConnectionCode) as string[]);

  const previousMissingUnitResponse = await env.dispatch_kv.get("missingUnit");
  if (previousMissingUnitResponse) {
    const previousMissingUnitJson = JSON.parse(previousMissingUnitResponse);
    if (!deepEqual(missingUnitResponse, previousMissingUnitJson)) {
      console.log("Missing units not equal, will notify!")
      sendMissingUnitsToSlack(missingUnitResponse);
    }
  }

  await env.dispatch_kv.put("missingUnit", JSON.stringify(missingUnitResponse));
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  return keysA.every(key => deepEqual(a[key], b[key]));
}

async function sendMissingUnitsToSlack(missingUnitResponse: any) {
  console.log("Sending missing units to Slack");

  var slackMessage = "";
  var sendMessage = false;
  if (missingUnitResponse.substations.notInSubstationList.length > 0) {
    slackMessage += "Missing unit in substation list: `" + missingUnitResponse.substations.notInSubstationList.join('`, `') + "`" + "\n";
    sendMessage = true;
  }
  if (missingUnitResponse.substations.notInDispatchList.length > 0) {
    slackMessage += "Missing substation in Real Time Dispatch: `" + missingUnitResponse.substations.notInDispatchList.join('`, `') + "`" + "\n";
    sendMessage = true;
  }
  if (missingUnitResponse.generation.notInGeneratorList.length > 0) {
    slackMessage += "Missing unit in generator list: `" + missingUnitResponse.generation.notInGeneratorList.join('`, `') + "`" + "\n";
    sendMessage = true;
  }
  if (missingUnitResponse.generation.notInDispatchList.length > 0) {
    slackMessage += "Missing generator in Real Time Dispatch: `" + missingUnitResponse.generation.notInDispatchList.join('`, `') + "`";
    sendMessage = true;
  }

  if (!sendMessage) {
    return;
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