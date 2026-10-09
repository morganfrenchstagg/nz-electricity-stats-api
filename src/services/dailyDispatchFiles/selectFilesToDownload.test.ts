import { it, describe, expect } from "vitest";

import { EmiDailyFile, selectFilesToDownload } from "./selectFilesToDownload";

const file = (date: string, lastModified: number): EmiDailyFile => ({ date, url: `https://example.com/${date}.csv`, lastModified });

describe("selectFilesToDownload", () => {
  it("downloads everything when nothing has been synced", () => {
    const files = [file("20261002", 1), file("20261001", 1)];

    expect(selectFilesToDownload(files, null, new Map()).map(f => f.date)).toEqual(["20261001", "20261002"]);
  });

  it("downloads files after the last sync date", () => {
    const files = [file("20261001", 100), file("20261002", 100), file("20261003", 100)];
    const stored = new Map([["20261001", 200], ["20261002", 200]]);

    expect(selectFilesToDownload(files, "20261002", stored).map(f => f.date)).toEqual(["20261003"]);
  });

  it("re-downloads older files that EMI has republished since they were stored", () => {
    const files = [file("20260901", 300), file("20260902", 100), file("20261003", 100)];
    const stored = new Map([["20260901", 200], ["20260902", 200]]);

    expect(selectFilesToDownload(files, "20261002", stored).map(f => f.date)).toEqual(["20260901", "20261003"]);
  });

  it("downloads older files that are missing from storage", () => {
    const files = [file("20260901", 100), file("20260902", 100)];
    const stored = new Map([["20260902", 200]]);

    expect(selectFilesToDownload(files, "20261002", stored).map(f => f.date)).toEqual(["20260901"]);
  });
});
