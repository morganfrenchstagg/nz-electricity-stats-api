import { env } from "cloudflare:workers";
import { RealTimeDispatch } from "../models/realTimeDispatch";
const emiApiUrl = "https://emi.azure-api.net/real-time-dispatch/";

// null until the dispatch sync has stored its first response
export async function fetchCachedDataFromEmiApi(): Promise<RealTimeDispatch[] | null> {
  const cachedData = await env.dispatch_kv.get("latestDispatch");
  return cachedData ? JSON.parse(cachedData) as RealTimeDispatch[] : null;
}

export async function fetchDataFromEmiApi() {
  console.log("Fetching from EMI RTD API");
  var response = await fetch(emiApiUrl, {
    headers: {
      "Ocp-Apim-Subscription-Key": env.EMI_API_KEY,
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60
    }
  });
  console.log("Response: " + response.status);
  return response;
}
