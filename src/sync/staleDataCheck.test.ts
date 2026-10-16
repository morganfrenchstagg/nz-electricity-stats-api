import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkForStaleData } from "./staleDataCheck";
import { mockFetch } from "../testing/fetchMock";

const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * ONE_MINUTE;

// stores a sync's checkpoint as last updated this long ago
async function storeCheckpoint(key: string, age: number) {
  await env.dispatch_kv.put(key, "checkpoint", { metadata: { updatedAt: Date.now() - age } });
}

function mockSlack() {
  return mockFetch({ [env.SLACK_WEBHOOK_URL as string]: () => new Response("ok") });
}

async function slackMessages(requests: Request[]) {
  return await Promise.all(requests.map(async request => (await request.json() as { text: string }).text));
}

describe("checkForStaleData", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T01:00:00Z"));
  });

  it("posts to Slack once the real time dispatch hasn't updated for an hour", async () => {
    await storeCheckpoint("latestDispatchTime", 59 * ONE_MINUTE);
    const requests = mockSlack();
    await checkForStaleData();
    expect(requests).toEqual([]);

    await storeCheckpoint("latestDispatchTime", 61 * ONE_MINUTE);
    await checkForStaleData();

    expect(await slackMessages(requests)).toEqual(["⏰ No new *real time dispatch data* for 1 hour"]);
    expect(JSON.parse((await env.dispatch_kv.get("staleDataAlerts"))!)).toEqual(["rtd"]);
  });

  it("posts to Slack once the daily dispatch or offer files haven't updated for 2 days", async () => {
    await storeCheckpoint("latestDailySyncDate", 49 * ONE_HOUR);
    await storeCheckpoint("latestSyncedOffers", 50 * ONE_HOUR);
    const requests = mockSlack();

    await checkForStaleData();

    expect(await slackMessages(requests)).toEqual([
      "⏰ No new *daily dispatch files* for 2 days\n⏰ No new *offer files* for 2 days",
    ]);
  });

  it("only posts once while the data stays stale, and again when it's getting new data", async () => {
    await storeCheckpoint("latestDispatchTime", 2 * ONE_HOUR);
    const requests = mockSlack();

    await checkForStaleData();
    await checkForStaleData();
    await storeCheckpoint("latestDispatchTime", 0);
    await checkForStaleData();

    expect(await slackMessages(requests)).toEqual([
      "⏰ No new *real time dispatch data* for 2 hours",
      "✅ Getting new *real time dispatch data* again",
    ]);
    expect(JSON.parse((await env.dispatch_kv.get("staleDataAlerts"))!)).toEqual([]);
  });

  it("doesn't check checkpoints stored before they recorded when they were updated", async () => {
    await env.dispatch_kv.put("latestDispatchTime", JSON.stringify("2026-10-14T22:00:00"));
    const requests = mockSlack();

    await checkForStaleData();

    expect(requests).toEqual([]);
  });
});
