import { env } from "cloudflare:workers";
const emiApiUrl = "https://emi.azure-api.net/real-time-dispatch/";

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
