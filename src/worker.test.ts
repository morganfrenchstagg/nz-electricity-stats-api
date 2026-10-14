import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./worker";
import { requestWorker } from "./testing/requestWorker";
import { getGenerators } from "./clients/generators";
import { getSubstations } from "./clients/substations";
import { syncDispatch } from "./sync/syncDispatch";
import { syncDailyDispatch } from "./sync/syncDailyDispatch";
import { syncDispatchAggregates } from "./sync/syncDispatchAggregates";
import { syncOffers } from "./sync/syncOffers";

vi.mock("./sync/syncDispatch", () => ({ syncDispatch: vi.fn() }));
vi.mock("./sync/syncDailyDispatch", () => ({ syncDailyDispatch: vi.fn() }));
vi.mock("./sync/syncOffers", () => ({ syncOffers: vi.fn() }));
vi.mock("./sync/syncDispatchAggregates", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sync/syncDispatchAggregates")>(),
  syncDispatchAggregates: vi.fn(),
}));

describe("routes", () => {
  it("redirects the root to the electricity map", async () => {
    const { response } = await requestWorker("/");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://electricitymap.frenchsta.gg/");
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

  it("allows cross origin requests", async () => {
    const { response } = await requestWorker("/v1/generators");

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns 404 for unknown routes", async () => {
    const { response } = await requestWorker("/v1/unknown");

    expect(response.status).toBe(404);
  });
});

describe("scheduled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runCron(cron: string) {
    return worker.scheduled({ cron, scheduledTime: Date.now(), noRetry: () => { } });
  }

  it("syncs real time dispatch every 2 minutes", async () => {
    await runCron("*/2 * * * *");

    expect(syncDispatch).toHaveBeenCalledOnce();
    expect(syncDailyDispatch).not.toHaveBeenCalled();
    expect(syncDispatchAggregates).not.toHaveBeenCalled();
    expect(syncOffers).not.toHaveBeenCalled();
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

    expect(syncDispatch).not.toHaveBeenCalled();
    expect(syncDailyDispatch).not.toHaveBeenCalled();
    expect(syncDispatchAggregates).not.toHaveBeenCalled();
    expect(syncOffers).not.toHaveBeenCalled();
  });
});
