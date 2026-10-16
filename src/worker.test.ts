import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./worker";
import { requestWorker } from "./testing/requestWorker";
import { getGenerators } from "./clients/generators";
import { getSubstations } from "./clients/substations";
import { syncDispatch } from "./sync/syncDispatch";
import { syncDailyDispatch } from "./sync/syncDailyDispatch";
import { syncDispatchAggregates } from "./sync/syncDispatchAggregates";
import { syncOffers } from "./sync/syncOffers";
import { checkForStaleData } from "./sync/staleDataCheck";

vi.mock("./sync/syncDispatch", () => ({ syncDispatch: vi.fn() }));
vi.mock("./sync/syncDailyDispatch", () => ({ syncDailyDispatch: vi.fn() }));
vi.mock("./sync/syncOffers", () => ({ syncOffers: vi.fn() }));
vi.mock("./sync/staleDataCheck", () => ({ checkForStaleData: vi.fn() }));
vi.mock("./sync/syncDispatchAggregates", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sync/syncDispatchAggregates")>(),
  syncDispatchAggregates: vi.fn(),
}));

describe("routes", () => {
  it("responds OK at the root, without redirecting", async () => {
    const { response } = await requestWorker("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("responds to ping", async () => {
    const { response } = await requestWorker("/ping");

    expect(await response.text()).toBe("pong");
  });

  it("returns the generator definitions, cached for a day", async () => {
    const { response } = await requestWorker("/v1/generators");

    expect(await response.json()).toEqual(await getGenerators());
    expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
  });

  it("returns the substation definitions, cached for a day", async () => {
    const { response } = await requestWorker("/v1/substations");

    expect(await response.json()).toEqual(await getSubstations());
    expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
  });

  it("returns generators and substations together as definitions", async () => {
    const { response } = await requestWorker("/v1/definitions");

    expect(await response.json()).toEqual({
      generators: await getGenerators(),
      substations: await getSubstations(),
    });
  });

  it("credits each data source and its licence, cached for a day", async () => {
    const { response } = await requestWorker("/v1/attribution");
    const { sources } = await response.json() as { sources: { endpoints: string[]; credit: string }[] };

    const creditFor = (endpoint: string) => sources.find(s => s.endpoints.includes(endpoint))?.credit;
    expect(creditFor("/v1/dispatch")).toBe("© Electricity Authority, licensed under CC BY 4.0");
    expect(creditFor("/v1/offers")).toBe("© Electricity Authority, licensed under CC BY 4.0");
    expect(creditFor("/v1/transmission-lines")).toBe("© Transpower New Zealand, licensed under CC BY 4.0");
    expect(creditFor("/v1/outages")).toBe("Outages from Transpower's Planned Outage Coordination Process (POCP)");
    expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
  });

  it("links every v1 response to the attribution", async () => {
    for (const path of ["/v1/generators", "/v1/outages", "/v1/unknown"]) {
      const { response } = await requestWorker(path);

      expect(response.headers.get("Link")).toBe('</v1/attribution>; rel="license"');
    }
  });

  it("returns unexpected errors with the attribution link too", async () => {
    vi.spyOn(env.dispatch, "get").mockRejectedValue(new Error("R2 is unavailable"));

    const { response } = await requestWorker("/v1/dispatch/2026-10-12");

    expect(response.headers.get("Link")).toBe('</v1/attribution>; rel="license"');
  });

  it("allows cross origin requests", async () => {
    const { response } = await requestWorker("/v1/generators");

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns 404 for unknown routes", async () => {
    const { response } = await requestWorker("/v1/unknown");

    expect(response.status).toBe(404);
  });

  it("returns unexpected errors as JSON, without caching them", async () => {
    vi.spyOn(env.dispatch, "get").mockRejectedValue(new Error("R2 is unavailable"));

    const { response } = await requestWorker("/v1/dispatch/2026-10-12");

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ message: "Internal server error" });
  });
});

describe("scheduled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runCron(cron: string) {
    return worker.scheduled({ cron, scheduledTime: Date.now(), noRetry: () => { } });
  }

  it("syncs real time dispatch and checks for stale data every 2 minutes", async () => {
    await runCron("*/2 * * * *");

    expect(syncDispatch).toHaveBeenCalledOnce();
    expect(checkForStaleData).toHaveBeenCalledOnce();
    expect(syncDailyDispatch).not.toHaveBeenCalled();
    expect(syncDispatchAggregates).not.toHaveBeenCalled();
    expect(syncOffers).not.toHaveBeenCalled();
  });

  it("still checks for stale data when the real time dispatch sync fails", async () => {
    vi.mocked(syncDispatch).mockRejectedValueOnce(new Error("EMI is down"));

    await expect(runCron("*/2 * * * *")).rejects.toThrow("EMI is down");

    expect(checkForStaleData).toHaveBeenCalledOnce();
  });

  it("syncs the daily dispatch files hourly, and aggregates them once they've finished syncing", async () => {
    let finishDailySync = () => { };
    vi.mocked(syncDailyDispatch).mockReturnValue(new Promise(resolve => finishDailySync = resolve));

    const run = runCron("02 * * * *");

    await Promise.resolve();
    expect(syncDailyDispatch).toHaveBeenCalledOnce();
    expect(syncDispatchAggregates).not.toHaveBeenCalled();

    finishDailySync();
    await run;

    expect(syncDispatchAggregates).toHaveBeenCalledOnce();
    expect(syncDispatch).not.toHaveBeenCalled();
    expect(syncOffers).not.toHaveBeenCalled();
  });

  it("syncs offers hourly", async () => {
    await runCron("45 * * * *");

    expect(syncOffers).toHaveBeenCalledOnce();
    expect(syncDispatch).not.toHaveBeenCalled();
    expect(syncDailyDispatch).not.toHaveBeenCalled();
  });

  it("ignores unknown schedules", async () => {
    await runCron("0 0 * * *");

    expect(checkForStaleData).not.toHaveBeenCalled();
    expect(syncDispatch).not.toHaveBeenCalled();
    expect(syncDailyDispatch).not.toHaveBeenCalled();
    expect(syncDispatchAggregates).not.toHaveBeenCalled();
    expect(syncOffers).not.toHaveBeenCalled();
  });
});
