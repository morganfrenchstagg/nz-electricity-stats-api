
# Running locally


Requirements
- wrangler


```
npm install
npm run dev
```

## Data and licensing

The API republishes data from:

- [Electricity Market Information (EMI)](https://www.emi.ea.govt.nz): real-time dispatch, nodal prices and volumes, metered generation, and bids and offers (`/v1/dispatch`, `/v1/offers`). Dispatch before 11 September 2020 comes from metered generation (see below). © [Electricity Authority](https://www.ea.govt.nz/copyright-disclaimer-transparency/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Transpower open data](https://data-transpower.opendata.arcgis.com/): transmission lines (`/v1/transmission-lines`). © [Transpower New Zealand](https://www.transpower.co.nz), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Transpower's [Planned Outage Coordination Process (POCP)](https://customerportal.transpower.co.nz/pocp/outages): generation outages (`/v1/outages`).
- [em6](https://www.em6.co.nz): the HVDC's flows and transfer limits over the last day, in each half hour (`hvdc` in `/v1/dispatch/recent`).

`GET /v1/attribution` lists these sources and the credit to give each one, and every `/v1` response links to it with a `Link: </v1/attribution>; rel="license"` header. If you re-use the data, credit its source as listed there. The sources are defined in `src/attribution.ts`.

This API isn't affiliated with or endorsed by the Electricity Authority, Transpower or any other data provider.

## Generation before the dispatch data

EMI's daily dispatch files start in September 2020, so the dispatch aggregates (`/v1/dispatch/aggregates`) before 11 September 2020 are filled in from EMI's metered generation ([Generation_MD](https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/Generation_MD)), which goes back to August 1997. For those days `/v1/dispatch/:date` also returns each unit's average generation (MW) in each half-hour trading period, without prices (including 10 September 2020, as EMI's first daily dispatch file only starts at 9:35am that day). They're generation only, as the metered data has no load other than generators' own.

The metered data identifies generators by their point of connection and a generator code (e.g. `HLY2201 huntly_e3p`) rather than the dispatch data's unit code (`HLY2201 HLY5`), so `src/data/meteredGenerationCodes.json` lists the unit each code is attributed to, or why it's excluded. It follows these rules:

- A code is attributed to the node EMI's [dispatched generation plant register](https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/GenerationFleet/Existing) gave the unit at the time. Where that isn't a node in `generators.json` (e.g. Cobb before it moved to `STK0661`, or plant retired before 2020 like Ōtāhuhu), it's added as a decommissioned unit.
- Where the metered data combines several units (e.g. Huntly's Rankine units), it's attributed to a unit that `combines` them, whose node is the metered code itself (e.g. `HLY2201 huntly_1_4`), as the split between them isn't known.
- Generation that isn't in the dispatch data (e.g. Ngāwhā's OEC1-3, which aren't dispatched) is excluded, so totals don't jump where the dispatch data takes over.

Generation_MD is missing some embedded generators for part of their history, so codes with a `source` fill those days in from EMI's other metered data, which only has their own codes read from it:

- [Embedded generation](https://www.emi.ea.govt.nz/Wholesale/Datasets/Metered_data/Embedded_generation), which Generation_MD takes its embedded generators from, identifies each by its point of connection and loss code (e.g. `STK0661 cobb`). It has Cobb (2015-2019), Mill Creek (from September 2015), Te Ahi O Maui (from October 2018), all of Mangahao (from October 2017, where Generation_MD only has about 0.15x of it), and Rotokawa, Kaimai, Te Rapa, Tararua, Highbank, Paerau and White Hill from April 2008, before they're in Generation_MD from 2009.
- [Grid import](https://www.emi.ea.govt.nz/Wholesale/Datasets/Metered_data/Grid_import) has what the Kawerau mill exported to the grid at `KAW0112` (2005-2019), by its network code (`KAW0112 skog`), as its cogeneration isn't metered on its own until 2020. It's about 0.7x what the cogeneration generates, as the mill uses the rest, and nearly all of it until 2013.

A unit's generation only comes from one dataset on any day, which the tests check, so it isn't counted twice.

The sync reports any Generation_MD code that isn't listed to Slack and leaves its generation out until it is. Changing how a code is attributed aggregates every month again on the next sync, and the tests check every code points to a unit in `generators.json`.
