import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { syncHvdc } from "./syncHvdc";
import { mockFetch } from "../testing/fetchMock";
import { em6Hvdc, EM6_HVDC_URL, HVDC_TIMESERIES } from "../testing/fixtures";
import { Em6HvdcResponse } from "../models/hvdc";

async function getStoredHvdc() {
  return await (await env.dispatch.get("hvdc"))?.json();
}

async function getStoredDay(date: string) {
  return await (await env.dispatch.get("hvdc-em6-" + date))?.json();
}

// em6's last day as the given half hours (e.g. 2026-10-28T20:00), each with the north flow given and the same limits
function em6Response(halfHours: [string, number][]): Em6HvdcResponse {
  const series = (value: (flow: number) => number) => halfHours.map(([time, flow]) => {
    const [year, month, day, hour, minute] = time.split(/[-T:]/).map(Number);
    return [{ year, month: month - 1, day, hour, minute }, value(flow)];
  }) as Em6HvdcResponse["data"][string];

  return {
    last_import: 1793172600,
    data: { dcn_flow: series(flow => flow), dcs_flow: series(() => 0), north_limit: series(() => 1200), south_limit: series(() => -650) },
  };
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

  it("keeps each day's half hours as em6's window moves past them", async () => {
    mockFetch({ [EM6_HVDC_URL]: () => Response.json(em6Hvdc()) });
    await syncHvdc();

    mockFetch({ [EM6_HVDC_URL]: () => Response.json(em6Response([["2026-10-28T20:30", 640], ["2026-10-28T21:00", 600]])) });
    await syncHvdc();

    expect(await getStoredDay("20261028")).toEqual({
      series: HVDC_TIMESERIES.series,
      data: [
        ["2026-10-28T20:00:00", 675, 0, 1200, -648],
        ["2026-10-28T20:30:00", 640, 0, 1200, -650],
        ["2026-10-28T21:00:00", 600, 0, 1200, -650],
      ],
    });
  });

  it("keeps the half hours either side of midnight in their own days", async () => {
    mockFetch({ [EM6_HVDC_URL]: () => Response.json(em6Response([["2026-10-28T23:30", 640], ["2026-10-29T00:00", 600]])) });

    await syncHvdc();

    expect(await getStoredDay("20261028")).toEqual({ series: HVDC_TIMESERIES.series, data: [["2026-10-28T23:30:00", 640, 0, 1200, -650]] });
    expect(await getStoredDay("20261029")).toEqual({ series: HVDC_TIMESERIES.series, data: [["2026-10-29T00:00:00", 600, 0, 1200, -650]] });
  });

  it("doesn't rewrite a day em6 hasn't added to", async () => {
    mockFetch({ [EM6_HVDC_URL]: () => Response.json(em6Hvdc()) });
    await syncHvdc();
    const put = vi.spyOn(env.dispatch, "put");

    await syncHvdc();

    expect(put.mock.calls.map(([key]) => key)).toEqual(["hvdc"]);
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
    expect((await env.dispatch.list({ prefix: "hvdc-em6-" })).objects).toEqual([]);
  });
});
