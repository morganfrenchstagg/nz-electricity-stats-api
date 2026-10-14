import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { mockFetch } from "../testing/fetchMock";

const ARCGIS_URL = "https://services3.arcgis.com/AkUq3zcWf7TVqyR9/arcgis/rest/services/TransmissionLines/FeatureServer/0/query";
const NOW = new Date("2026-10-14T09:00:00Z").getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const lines = (name: string) => JSON.stringify({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { name }, geometry: null }],
});

async function cacheLines(body: string, fetchedAt: number) {
  await env.dispatch_kv.put("transmissionLines", body, { metadata: { fetchedAt } });
}

describe("transmission lines api", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("fetches and caches the lines from ArcGIS the first time", async () => {
    mockFetch({ [ARCGIS_URL]: () => new Response(lines("new")) });

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(lines("new"));
    expect(response.headers.get("Content-Type")).toBe("application/geo+json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await env.dispatch_kv.getWithMetadata("transmissionLines")).toEqual({
      value: lines("new"),
      metadata: { fetchedAt: NOW },
    });
  });

  it("serves cached lines without calling ArcGIS while they're under a day old", async () => {
    await cacheLines(lines("cached"), NOW - ONE_DAY_MS + 1000);
    const requests = mockFetch({});

    const { response, finishBackgroundWork } = await requestWorker("/v1/transmission-lines");
    await finishBackgroundWork();

    expect(await response.text()).toBe(lines("cached"));
    expect(requests).toEqual([]);
  });

  it("serves stale lines straight away, and refreshes them in the background", async () => {
    await cacheLines(lines("stale"), NOW - ONE_DAY_MS);
    mockFetch({ [ARCGIS_URL]: () => new Response(lines("new")) });

    const { response, finishBackgroundWork } = await requestWorker("/v1/transmission-lines");

    expect(await response.text()).toBe(lines("stale"));

    await finishBackgroundWork();

    expect(await env.dispatch_kv.getWithMetadata("transmissionLines")).toEqual({
      value: lines("new"),
      metadata: { fetchedAt: NOW },
    });
  });

  it("keeps serving stale lines when the background refresh fails", async () => {
    await cacheLines(lines("stale"), NOW - ONE_DAY_MS);
    mockFetch({ [ARCGIS_URL]: () => new Response("Service unavailable", { status: 503 }) });

    const { response, finishBackgroundWork } = await requestWorker("/v1/transmission-lines");
    await finishBackgroundWork();

    expect(await response.text()).toBe(lines("stale"));
    expect(await env.dispatch_kv.get("transmissionLines")).toBe(lines("stale"));
  });

  it("returns 502 when nothing is cached and ArcGIS fails", async () => {
    mockFetch({ [ARCGIS_URL]: () => new Response("Service unavailable", { status: 503 }) });

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Transmission lines are temporarily unavailable" });
  });

  it("doesn't cache an incomplete response from ArcGIS", async () => {
    mockFetch({
      [ARCGIS_URL]: () => Response.json({ ...JSON.parse(lines("partial")), exceededTransferLimit: true }),
    });

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(response.status).toBe(502);
    expect(await env.dispatch_kv.get("transmissionLines")).toBeNull();
  });
});
