import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { checkForNewGenerationRecords, syncGenerationRecords } from "./syncGenerationRecords";
import { mockFetch } from "../testing/fetchMock";
import { rtd } from "../testing/fixtures";

const ATIAMURI = "ATI2201 ATI0";

// stores a daily dispatch file with Ātiamuri at the given output in each interval (e.g. 18:00 => 80)
async function storeDailyFile(date: string, outputByTime: Record<string, number>) {
  const intervals = Object.fromEntries(Object.entries(outputByTime).map(([time, mw]) => [
    `${date}T${time}:00`,
    [{ p: ATIAMURI, g: `${mw}`, l: "0", c: "100" }],
  ]));
  await env.dispatch.put("dispatch-" + date.replace(/-/g, ""), JSON.stringify(intervals));
}

async function getKvJson(key: string) {
  const value = await env.dispatch_kv.get(key);
  return value ? JSON.parse(value) : null;
}

describe("syncGenerationRecords", () => {
  it("waits until the daily dispatch has been synced", async () => {
    await storeDailyFile("2026-10-05", { "18:00": 80 });

    await syncGenerationRecords();

    expect(await env.dispatch_kv.get("historicalGenerationRecords")).toBeNull();
  });

  it("finds each unit's record in the daily files the daily sync has finished with", async () => {
    await storeDailyFile("2026-10-05", { "18:00": 80, "18:05": 82 });
    await storeDailyFile("2026-10-06", { "12:00": 81 });
    await storeDailyFile("2026-10-07", { "12:00": 84 });
    await env.dispatch_kv.put("latestDailySyncDate", "20261006");

    await syncGenerationRecords();

    expect(await getKvJson("historicalGenerationRecords")).toEqual({
      syncedTo: "20261006",
      records: { [ATIAMURI]: { mw: 82, time: "2026-10-05T18:05:00" } },
    });
  });

  it("carries on from the last file it read on later runs", async () => {
    await storeDailyFile("2026-10-05", { "18:00": 80 });
    await storeDailyFile("2026-10-06", { "18:00": 70 });
    await env.dispatch_kv.put("latestDailySyncDate", "20261006");
    await syncGenerationRecords();

    // a change to a file that's already been read isn't picked up
    await storeDailyFile("2026-10-05", { "18:00": 99 });
    await storeDailyFile("2026-10-07", { "18:00": 75 });
    await env.dispatch_kv.put("latestDailySyncDate", "20261007");
    await syncGenerationRecords();

    expect(await getKvJson("historicalGenerationRecords")).toEqual({
      syncedTo: "20261007",
      records: { [ATIAMURI]: { mw: 80, time: "2026-10-05T18:00:00" } },
    });
  });
});

describe("checkForNewGenerationRecords", () => {
  const time = "2026-10-14T22:00:00";

  async function storeHistoricalRecords(syncedTo: string, mw: number) {
    await env.dispatch_kv.put("historicalGenerationRecords", JSON.stringify({
      syncedTo,
      records: { [ATIAMURI]: { mw, time: "2024-03-03T18:30:00" } },
    }));
  }

  function mockSlack() {
    return mockFetch({ [env.SLACK_WEBHOOK_URL as string]: () => new Response("ok") });
  }

  async function slackMessages(requests: Request[]) {
    return await Promise.all(requests.map(async request => (await request.json() as { text: string }).text));
  }

  it("posts units beating their record to Slack, and keeps the new records", async () => {
    await storeHistoricalRecords("20261013", 80);
    const requests = mockSlack();

    await checkForNewGenerationRecords([rtd(ATIAMURI, 83.5, 0, 100, time)]);

    expect(await slackMessages(requests)).toEqual([
      "🏆 *Ātiamuri* (`ATI2201 ATI0`) is generating *83.5 MW*, a new record (previously 80 MW at 6:30pm on 3 March 2024)",
    ]);
    expect(await getKvJson("liveGenerationRecords")).toEqual({ [ATIAMURI]: { mw: 83.5, time } });
  });

  it("doesn't post anything when no records are beaten", async () => {
    await storeHistoricalRecords("20261013", 80);
    const requests = mockSlack();

    await checkForNewGenerationRecords([rtd(ATIAMURI, 80, 0, 100, time)]);

    expect(requests).toEqual([]);
    expect(await env.dispatch_kv.get("liveGenerationRecords")).toBeNull();
  });

  it("only posts the first new record for a unit each day", async () => {
    await storeHistoricalRecords("20261013", 80);
    const requests = mockSlack();

    await checkForNewGenerationRecords([rtd(ATIAMURI, 81, 0, 100, "2026-10-14T12:00:00")]);
    await checkForNewGenerationRecords([rtd(ATIAMURI, 82, 0, 100, "2026-10-14T12:05:00")]);
    await checkForNewGenerationRecords([rtd(ATIAMURI, 83, 0, 100, "2026-10-15T12:00:00")]);

    expect(await slackMessages(requests)).toEqual([
      "🏆 *Ātiamuri* (`ATI2201 ATI0`) is generating *81 MW*, a new record (previously 80 MW at 6:30pm on 3 March 2024)",
      "🏆 *Ātiamuri* (`ATI2201 ATI0`) is generating *83 MW*, a new record (previously 82 MW at 12:05pm on 14 October 2026)",
    ]);
    expect(await getKvJson("liveGenerationRecords")).toEqual({ [ATIAMURI]: { mw: 83, time: "2026-10-15T12:00:00" } });
  });

  it("posts a unit's first generation, then only records it climbing the rest of the day", async () => {
    await storeHistoricalRecords("20261013", 80);
    const requests = mockSlack();

    await checkForNewGenerationRecords([rtd("ISL0661 KPS0", 3, 0, 100, "2026-10-14T09:00:00")]);
    await checkForNewGenerationRecords([rtd("ISL0661 KPS0", 8.7, 0, 100, "2026-10-14T09:05:00")]);

    expect(await slackMessages(requests)).toEqual([
      "🆕 *Kōwhai Park* (`ISL0661 KPS0`) is generating for the first time on record (*3 MW*)",
    ]);
    expect(await getKvJson("liveGenerationRecords")).toEqual({ "ISL0661 KPS0": { mw: 8.7, time: "2026-10-14T09:05:00" } });
  });

  it("compares against the records from the daily files when they've since gone higher", async () => {
    await env.dispatch_kv.put("liveGenerationRecords", JSON.stringify({ [ATIAMURI]: { mw: 81, time: "2026-10-10T12:00:00" } }));
    await storeHistoricalRecords("20261013", 83);
    const requests = mockSlack();

    await checkForNewGenerationRecords([rtd(ATIAMURI, 82, 0, 100, time)]);

    expect(requests).toEqual([]);
  });

  it.each([
    { problem: "haven't been found yet", syncedTo: null },
    { problem: "are more than a week behind", syncedTo: "20261006" },
  ])("doesn't check for new records while the records from the daily files $problem", async ({ syncedTo }) => {
    if (syncedTo) {
      await storeHistoricalRecords(syncedTo, 80);
    }
    const requests = mockSlack();

    await checkForNewGenerationRecords([rtd(ATIAMURI, 83, 0, 100, time)]);

    expect(requests).toEqual([]);
    expect(await env.dispatch_kv.get("liveGenerationRecords")).toBeNull();
  });

  it("keeps the new records when Slack is down", async () => {
    await storeHistoricalRecords("20261013", 80);
    mockFetch({ [env.SLACK_WEBHOOK_URL as string]: () => new Response("error", { status: 500 }) });

    await checkForNewGenerationRecords([rtd(ATIAMURI, 83, 0, 100, time)]);

    expect(await getKvJson("liveGenerationRecords")).toEqual({ [ATIAMURI]: { mw: 83, time } });
  });
});
