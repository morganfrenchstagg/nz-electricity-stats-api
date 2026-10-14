import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { requestWorker } from "../testing/requestWorker";

const offers = {
  "1": { "ATI2201 ATI0": [{ tranche: 1, megawatts: 40, price: 0.01 }] },
};

describe("offers api", () => {
  beforeEach(async () => {
    await env.offers.put("offers-20261012", JSON.stringify(offers));
  });

  it("returns a day's offers, cached for a day", async () => {
    const { response } = await requestWorker("/v1/offers/2026-10-12");

    expect(await response.json()).toEqual({ date: "20261012", data: offers });
    expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
  });

  it("returns the latest synced day's offers, cached for an hour", async () => {
    await env.dispatch_kv.put("latestSyncedOffers", "20261012");

    const { response } = await requestWorker("/v1/offers/latest");

    expect(await response.json()).toEqual({ date: "20261012", data: offers });
    expect(response.headers.get("Cache-Control")).toBe("max-age=3600");
  });

  it("returns 404 for the latest offers before any have been synced", async () => {
    const { response } = await requestWorker("/v1/offers/latest");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "No offers have been synced yet" });
  });

  it("returns 404 for a day that hasn't been synced", async () => {
    const { response } = await requestWorker("/v1/offers/2026-10-13");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "No data for this date" });
  });
});
