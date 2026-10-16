
# Running locally


Requirements
- wrangler


```
npm install
npm run dev
```

## Data and licensing

The API republishes data from:

- [Electricity Market Information (EMI)](https://www.emi.ea.govt.nz): real-time dispatch, nodal prices and volumes, and bids and offers (`/v1/dispatch`, `/v1/offers`). © [Electricity Authority](https://www.ea.govt.nz/copyright-disclaimer-transparency/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Transpower open data](https://data-transpower.opendata.arcgis.com/): transmission lines (`/v1/transmission-lines`). © [Transpower New Zealand](https://www.transpower.co.nz), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Transpower's [Planned Outage Coordination Process (POCP)](https://customerportal.transpower.co.nz/pocp/outages): generation outages (`/v1/outages`).

`GET /v1/attribution` lists these sources and the credit to give each one, and every `/v1` response links to it with a `Link: </v1/attribution>; rel="license"` header. If you re-use the data, credit its source as listed there. The sources are defined in `src/attribution.ts`.

This API isn't affiliated with or endorsed by the Electricity Authority, Transpower or any other data provider.
