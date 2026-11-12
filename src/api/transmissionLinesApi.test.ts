import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestWorker } from "../testing/requestWorker";
import { mockFetch } from "../testing/fetchMock";

const ARCGIS_URL = "https://services3.arcgis.com/AkUq3zcWf7TVqyR9/arcgis/rest/services/TransmissionLines/FeatureServer/0/query";
const NOW = new Date("2026-10-14T09:00:00Z").getTime();
const ONE_HOUR_MS = 60 * 60 * 1000;

const lines = (name: string) => JSON.stringify({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { name }, geometry: null }],
});

describe("transmission lines api", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("returns the lines from ArcGIS, cached for a day", async () => {
    mockFetch({ [ARCGIS_URL]: () => new Response(lines("new")) });

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(lines("new"));
    expect(response.headers.get("Content-Type")).toBe("application/geo+json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("asks ArcGIS for simplified lines, with only the fields worth showing", async () => {
    const requests = mockFetch({ [ARCGIS_URL]: () => new Response(lines("new")) });

    await requestWorker("/v1/transmission-lines");

    const params = new URL(requests[0].url).searchParams;
    expect(params.get("maxAllowableOffset")).toBe("0.00005");
    expect(params.get("geometryPrecision")).toBe("5");
    expect(params.get("outFields")).toBe("MXLOCATION,designvolt,status,description,type");
    expect(params.get("f")).toBe("geojson");
  });

  it("answers later requests from the edge cache without calling ArcGIS again", async () => {
    const requests = mockFetch({ [ARCGIS_URL]: () => new Response(lines("new")) });
    await (await requestWorker("/v1/transmission-lines")).finishBackgroundWork();
    vi.setSystemTime(NOW + ONE_HOUR_MS);

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(requests).toHaveLength(1);
    expect(await response.text()).toBe(lines("new"));
    expect(response.headers.get("Content-Type")).toBe("application/geo+json");
    expect(response.headers.get("Age")).toBe("3600");
  });

  it("calls ArcGIS again once the edge cache's day is up", async () => {
    let name = "old";
    const requests = mockFetch({ [ARCGIS_URL]: () => new Response(lines(name)) });
    await (await requestWorker("/v1/transmission-lines")).finishBackgroundWork();
    name = "new";
    vi.setSystemTime(NOW + 24 * ONE_HOUR_MS);

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(requests).toHaveLength(2);
    expect(await response.text()).toBe(lines("new"));
  });

  it("returns 502 when ArcGIS fails, without keeping it in the edge cache", async () => {
    let ok = false;
    mockFetch({ [ARCGIS_URL]: () => ok ? new Response(lines("new")) : new Response("Service unavailable", { status: 503 }) });

    const failed = await requestWorker("/v1/transmission-lines");
    await failed.finishBackgroundWork();

    expect(failed.response.status).toBe(502);
    expect(failed.response.headers.get("Cache-Control")).toBe("no-store");
    expect(await failed.response.json()).toEqual({ error: "Transmission lines are temporarily unavailable" });

    ok = true;
    const { response } = await requestWorker("/v1/transmission-lines");

    expect(response.status).toBe(200);
  });

  it("returns 502 for an incomplete response from ArcGIS", async () => {
    mockFetch({
      [ARCGIS_URL]: () => Response.json({ ...JSON.parse(lines("partial")), exceededTransferLimit: true }),
    });

    const { response } = await requestWorker("/v1/transmission-lines");

    expect(response.status).toBe(502);
  });
});
