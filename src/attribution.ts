// where the API's data comes from, crediting each source the way the electricity map's About this site does.
// served at /v1/attribution, which every /v1 response links to

const CC_BY = { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" };

export const ATTRIBUTION = {
  sources: [
    {
      data: "Real-time dispatch, nodal prices and volumes, metered generation and HVDC flows, and bids and offers",
      endpoints: ["/v1/dispatch", "/v1/offers"],
      source: { name: "Electricity Market Information (EMI)", url: "https://www.emi.ea.govt.nz" },
      copyright: { holder: "Electricity Authority", url: "https://www.ea.govt.nz/copyright-disclaimer-transparency/" },
      licence: CC_BY,
      credit: "© Electricity Authority, licensed under CC BY 4.0",
    },
    {
      data: "Transmission lines",
      endpoints: ["/v1/transmission-lines"],
      source: { name: "Transpower open data", url: "https://data-transpower.opendata.arcgis.com/" },
      copyright: { holder: "Transpower New Zealand", url: "https://www.transpower.co.nz" },
      licence: CC_BY,
      credit: "© Transpower New Zealand, licensed under CC BY 4.0",
    },
    {
      // POCP doesn't publish licence terms, so this credits the source without claiming one
      data: "Generation outages",
      endpoints: ["/v1/outages"],
      source: { name: "Transpower's Planned Outage Coordination Process (POCP)", url: "https://customerportal.transpower.co.nz/pocp/outages" },
      credit: "Outages from Transpower's Planned Outage Coordination Process (POCP)",
    },
    {
      // nor does em6
      data: "HVDC flows and transfer limits",
      endpoints: ["/v1/dispatch/recent", "/v1/dispatch/:date", "/v1/dispatch/aggregates"],
      source: { name: "em6", url: "https://www.em6.co.nz" },
      credit: "HVDC flows and transfer limits from em6",
    },
  ],
  disclaimer: "This API isn't affiliated with or endorsed by the Electricity Authority, Transpower or any other data provider. "
    + "Data is provided as is and may be delayed, incomplete or wrong, so don't rely on it for operational, trading or other decisions.",
};

export const ATTRIBUTION_LINK = '</v1/attribution>; rel="license"';
