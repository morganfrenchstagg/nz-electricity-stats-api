import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { outage } from "../testing/fixtures";

describe("outages api", () => {
  it("returns the current outages for each unit, cached for an hour", async () => {
    await env.dispatch_kv.put("latestOutages", JSON.stringify({
      "ATI2201 ATI0": [outage("ATI_0", { mwattLost: 40, mwattRemaining: 44 })],
    }));

    const { response } = await requestWorker("/v1/outages");

    expect(await response.json()).toEqual({
      "ATI2201 ATI0": [{
        outageBlock: "ATI_0",
        timeStart: "2026-10-14T08:00:00Z",
        timeEnd: "2026-10-16T05:00:00Z",
        mwattLost: 40,
      }],
    });
    expect(response.headers.get("Cache-Control")).toBe("max-age=3600");
  });

  it("returns no outages before they've been synced", async () => {
    const { response } = await requestWorker("/v1/outages");

    expect(await response.json()).toEqual({});
  });
});
