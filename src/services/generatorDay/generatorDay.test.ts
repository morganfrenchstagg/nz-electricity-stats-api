import { describe, expect, it } from "vitest";

import { getStationNodes, summariseDay } from "./generatorDay";
import { getGenerators } from "../../clients/generators";

const unitsOf = async (site: string) =>
  (await getGenerators()).find((generator) => generator.site === site)!.units;

describe("getStationNodes", () => {
  it("has the units in service that day as well as the ones in the data, in the order they're defined", async () => {
    expect(
      getStationNodes(await unitsOf("HLY"), ["HLY2201 HLY1", "ALB0331"], "2026-10-14"),
    ).toEqual([
      "HLY2201 HLY5",
      "HLY2201 HLY6",
      "HLY2201 HLY1",
      "HLY2201 HLY2",
      "HLY2201 HLY4",
      "HLY2201 HLY11",
      "HLY2201 HLY91",
    ]);
  });

  it("has a unit on the day it's decommissioned, but not after", async () => {
    // Pātea's units moved from HWA1101 to OHG1101 at 13:59 on 25 June 2026
    const units = await unitsOf("PTA");

    expect(getStationNodes(units, [], "2026-06-25")).toContain("HWA1101 PTA1");
    expect(getStationNodes(units, [], "2026-06-26")).not.toContain("HWA1101 PTA1");
    expect(getStationNodes(units, [], "2026-06-26")).toContain("OHG1101 PTA1");
  });

  it("only has a unit still being commissioned when it's in the data", async () => {
    // Ruakākā's solar farm has no commissioned date
    const units = await unitsOf("RUK");

    expect(getStationNodes(units, [], "2026-10-14")).not.toContain("BRB0331 RUS0");
    expect(getStationNodes(units, ["BRB0331 RUS0"], "2026-10-14")).toContain("BRB0331 RUS0");
  });

  it("only has the units in the metered data before the dispatch data began", async () => {
    // Rankine 1-4 were in service, but the metered data combines them
    expect(getStationNodes(await unitsOf("HLY"), ["HLY2201 huntly_1_4"], "1998-06-01")).toEqual([
      "HLY2201 huntly_1_4",
    ]);
  });
});

describe("summariseDay", () => {
  it("doesn't count an interval missing from the data as 0", () => {
    // 00:05 is missing, so it's the mean of the two intervals over the 15 minutes to the end of 00:10's
    const { station, units } = summariseDay(
      {
        series: ["ATI2201 ATI0"],
        data: [
          ["2026-10-14T00:00:00", 40],
          ["2026-10-14T00:10:00", 60],
        ],
        pricing: [
          ["2026-10-14T00:00:00", 100],
          ["2026-10-14T00:10:00", 110],
        ],
      },
      0.25,
    );

    expect(units.get("ATI2201 ATI0")).toEqual({
      energy: 12.5,
      peak: { mw: 60, time: "2026-10-14T00:10:00" },
      latest: { mw: 60, price: 110 },
    });
    expect(station).toEqual({ energy: 12.5, peak: { mw: 60, time: "2026-10-14T00:10:00" } });
  });

  it("has no summaries when none of the station's units have a column", () => {
    const { station, units } = summariseDay(
      { series: [], data: [["2026-10-14T00:00:00"]], pricing: [["2026-10-14T00:00:00"]] },
      0.0833,
    );

    expect(station).toBeUndefined();
    expect(units.size).toBe(0);
  });
});
