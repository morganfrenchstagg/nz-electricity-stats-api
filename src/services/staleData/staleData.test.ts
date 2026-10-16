import { describe, expect, it } from "vitest";

import { DataSourceStatus, findStaleDataChanges, formatStaleDataMessage } from "./staleData";

const ONE_HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-16T01:00:00Z");

function status(id: string, name: string, maxAgeMs: number, age?: number): DataSourceStatus {
  return { id, name, checkpointKey: id, maxAgeMs, updatedAt: age === undefined ? undefined : now - age };
}

const rtd = (age?: number) => status("rtd", "real time dispatch data", ONE_HOUR, age);
const offers = (age?: number) => status("offers", "offer files", 48 * ONE_HOUR, age);

describe("findStaleDataChanges", () => {
  it("finds sources that have gone longer than their max age without new data", () => {
    const changes = findStaleDataChanges([rtd(ONE_HOUR + 1), offers(47 * ONE_HOUR)], [], now);

    expect(changes.newlyStale.map(status => status.id)).toEqual(["rtd"]);
    expect(changes.recovered).toEqual([]);
    expect(changes.alerted).toEqual(["rtd"]);
  });

  it("doesn't report sources that were already stale again", () => {
    const changes = findStaleDataChanges([rtd(2 * ONE_HOUR), offers(49 * ONE_HOUR)], ["rtd"], now);

    expect(changes.newlyStale.map(status => status.id)).toEqual(["offers"]);
    expect(changes.alerted).toEqual(["rtd", "offers"]);
  });

  it("finds stale sources that are getting new data again", () => {
    const changes = findStaleDataChanges([rtd(5 * 60 * 1000), offers(49 * ONE_HOUR)], ["rtd", "offers"], now);

    expect(changes.newlyStale).toEqual([]);
    expect(changes.recovered.map(status => status.id)).toEqual(["rtd"]);
    expect(changes.alerted).toEqual(["offers"]);
  });

  it("leaves sources that don't know when they last got new data as they were", () => {
    const changes = findStaleDataChanges([rtd(), offers()], ["offers"], now);

    expect(changes).toEqual({ newlyStale: [], recovered: [], alerted: ["offers"] });
  });
});

describe("formatStaleDataMessage", () => {
  it("says how long stale sources have gone without new data, and which are getting it again", () => {
    const message = formatStaleDataMessage([rtd(ONE_HOUR + 1), offers(49 * ONE_HOUR)], [status("dailyDispatch", "daily dispatch files", 48 * ONE_HOUR, 0)], now);

    expect(message).toBe(
      "⏰ No new *real time dispatch data* for 1 hour\n" +
      "⏰ No new *offer files* for 2 days\n" +
      "✅ Getting new *daily dispatch files* again"
    );
  });

  it.each([
    { age: 2 * ONE_HOUR, expected: "2 hours" },
    { age: 47.9 * ONE_HOUR, expected: "47 hours" },
    { age: 75 * ONE_HOUR, expected: "3 days" },
  ])("shows $expected without new data", ({ age, expected }) => {
    expect(formatStaleDataMessage([rtd(age)], [], now)).toBe(`⏰ No new *real time dispatch data* for ${expected}`);
  });
});
