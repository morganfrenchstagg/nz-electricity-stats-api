import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { requestWorker } from "../testing/requestWorker";

const offers = {
  "1": { "ATI2201 ATI0": [{ tranche: 1, megawatts: 40, price: 0.01 }] },
};

const fogp = {
  "1": { "WWD1102 WWD1": 63.5 },
  "2": { "WWD1102 WWD1": 0 },
};

describe("offers api", () => {
  beforeEach(async () => {
    await env.offers.put("offers-20261012", JSON.stringify(offers));
    await env.offers.put("fogp-20261012", JSON.stringify(fogp));
  });

  it("returns a day's offers and forecasts of generation potential, cached for a day", async () => {
    const { response } = await requestWorker("/v1/offers/2026-10-12");

    expect(await response.json()).toEqual({ date: "20261012", data: offers, fogp });
    expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
  });

  it("returns the latest synced day's offers and forecasts, cached for an hour", async () => {
    await env.dispatch_kv.put("latestSyncedOffers", "20261012");

    const { response } = await requestWorker("/v1/offers/latest");

    expect(await response.json()).toEqual({ date: "20261012", data: offers, fogp });
    expect(response.headers.get("Cache-Control")).toBe("max-age=3600");
  });

  it("returns no forecasts for a day synced before they were kept", async () => {
    await env.offers.put("offers-20261011", JSON.stringify(offers));

    const { response } = await requestWorker("/v1/offers/2026-10-11");

    expect(await response.json()).toEqual({ date: "20261011", data: offers, fogp: {} });
  });

  it("returns 503 for the latest offers before any have been synced", async () => {
    const { response } = await requestWorker("/v1/offers/latest");

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ message: "Offers have not been synced yet" });
  });

  it("returns 404 for a day that hasn't been synced", async () => {
    const { response } = await requestWorker("/v1/offers/2026-10-13");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "No data for this date" });
  });
});
