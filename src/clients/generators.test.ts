import { describe, expect, it } from "vitest";

import { getGenerators } from "./generators";

describe("generators.json", () => {
  it("dates plant running before EMI's register began from when it first generated, not EMI's 1899 placeholder", async () => {
    const units = (await getGenerators()).flatMap(generator => generator.units);
    expect(units.filter(unit => unit.commissioned?.startsWith("1899")).map(unit => unit.node)).toEqual([]);
  });
});
