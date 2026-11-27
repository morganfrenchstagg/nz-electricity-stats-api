import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { ApiClient, FetchApi } from "./api";
import { registerDayProfileTool } from "./tools/dayProfile";
import { registerEnergyTool } from "./tools/energy";
import { registerGeneratorTools } from "./tools/generators";
import { registerLiveTool } from "./tools/live";
import { registerOffersTool } from "./tools/offers";
import { registerOutagesTool } from "./tools/outages";
import { registerPricesTool } from "./tools/prices";

// what an agent reads before choosing a tool, so it knows what the data covers and how to word its answers
const INSTRUCTIONS = `Statistics about New Zealand's wholesale electricity market, from the NZ Electricity Stats API.

What the data covers:
- Generation from August 1997 to now: EMI's half-hourly metered generation until 10 September 2020, then the 5-minute dispatch. Only the grid's dispatched generating units, so no rooftop solar or most small embedded generation.
- Demand (what's taken from the grid, at grid exit points and by dispatchable loads and batteries charging) from August 1997 too: EMI's metered grid export and import until 10 September 2020, then the dispatch.
- Wholesale prices from 11 September 2020.
- The HVDC link's flows between the islands from August 1997.
- Generators' energy offers from October 2019, and generation outages from about 14 days ago to 3 days ahead.
- EMI publishes each day's dispatch the day after, so today (and sometimes yesterday) come from the live dispatch and the latest periods can be incomplete.

Units and conventions: energy in GWh (1 GWh = 1,000 MWh), power in MW, prices in $/MWh (NZD, the real-time dispatch prices, before final pricing). Dates are NZ trading dates and times are NZ local time (Pacific/Auckland) without an offset unless one is given. Fuels are Hydro, Geothermal, Gas, Coal/Gas (Huntly's Rankine units), Wind, Solar, Battery and Diesel, and renewables are hydro, geothermal, wind and solar.

Choosing a tool:
- Totals, trends and shares over days, weeks, months or years: get_energy.
- What happened through a single day (peaks, half-hourly patterns): get_day_profile.
- Prices over up to a month: get_prices.
- Right now: get_current_state.
- Station details, names and codes: search_generators. Installed capacity over time: get_generating_capacity.
- Outages: get_outages. The offer stack: get_offers.

The tools do the grouping and arithmetic, so prefer one call with the right group_by and range over many small calls. State the period and any caveats in the notes (e.g. incomplete periods) when you answer.

Credit the data's sources when you present it: generation, prices, HVDC flows and offers are from the Electricity Market Information website (emi.ea.govt.nz), © Electricity Authority, licensed under CC BY 4.0; outages are from Transpower's POCP; recent HVDC flows and limits are from em6. This isn't affiliated with the Electricity Authority or Transpower, and the data is provided as is.`;

export function createMcpServer(fetchApi: FetchApi): McpServer {
  // ajv, the SDK's default validator, compiles schemas with new Function, which Workers don't allow
  const server = new McpServer(
    {
      name: "nz-electricity-stats",
      title: "NZ Electricity Stats",
      version: "1.0.0",
      websiteUrl: "https://github.com/morganfrenchstagg/nz-electricity-stats-api",
    },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const api = new ApiClient(fetchApi);

  registerEnergyTool(server, api);
  registerDayProfileTool(server, api);
  registerPricesTool(server, api);
  registerLiveTool(server, api);
  registerGeneratorTools(server);
  registerOutagesTool(server, api);
  registerOffersTool(server, api);

  return server;
}
