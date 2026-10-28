import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { syncHvdc } from "./syncHvdc";
import { mockFetch } from "../testing/fetchMock";
import { em6Hvdc, EM6_HVDC_URL, HVDC_TIMESERIES } from "../testing/fixtures";

async function getStoredHvdc() {
  return await (await env.dispatch.get("hvdc"))?.json();
}

const cachedHvdc = { series: HVDC_TIMESERIES.series, data: [["2026-10-28T19:30:00", 700, 0, 1200, -640]] };

describe("syncHvdc", () => {
  it("stores the last day's HVDC from em6", async () => {
    const requests = mockFetch({ [EM6_HVDC_URL]: () => Response.json(em6Hvdc()) });

    await syncHvdc();

    expect(requests).toHaveLength(1);
    expect(await getStoredHvdc()).toEqual(HVDC_TIMESERIES);
  });

  it("replaces the HVDC it stored before", async () => {
    await env.dispatch.put("hvdc", JSON.stringify(cachedHvdc));
    mockFetch({ [EM6_HVDC_URL]: () => Response.json(em6Hvdc()) });

    await syncHvdc();

    expect(await getStoredHvdc()).toEqual(HVDC_TIMESERIES);
  });

  it.each([
    ["em6 returns an error", () => Response.json({ message: "Service Unavailable" }, { status: 503 })],
    ["em6 returns no half hours", () => Response.json({ data: { dcn_flow: [], dcs_flow: [], north_limit: [], south_limit: [] } })],
    ["em6 can't be reached", () => { throw new TypeError("fetch failed"); }],
  ])("keeps the cached HVDC, without throwing, when %s", async (_, respond) => {
    await env.dispatch.put("hvdc", JSON.stringify(cachedHvdc));
    mockFetch({ [EM6_HVDC_URL]: respond });

    await expect(syncHvdc()).resolves.toBeUndefined();

    expect(await getStoredHvdc()).toEqual(cachedHvdc);
  });
});
