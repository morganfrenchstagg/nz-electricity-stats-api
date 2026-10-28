import { Em6HvdcResponse } from "../models/hvdc";
import { isValidHvdcResponse } from "../services/hvdc/hvdc";

const em6HvdcUrl = "https://www.transpower.co.nz/em6/data/hvdc";

export async function fetchHvdcFromEm6(): Promise<Em6HvdcResponse> {
  console.log("Fetching HVDC from em6");
  const response = await fetch(em6HvdcUrl);
  if (!response.ok) {
    throw new Error(`em6 HVDC request failed with status ${response.status}`);
  }

  const json = await response.json();
  if (!isValidHvdcResponse(json)) {
    throw new Error("em6 HVDC response had no HVDC data");
  }

  return json as Em6HvdcResponse;
}
