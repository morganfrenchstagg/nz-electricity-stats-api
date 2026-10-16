import { describe, expect, it } from "vitest";

import { findUnitsOverCapacity, formatUnitsOverCapacityMessage } from "./overCapacityChecker";
import { GeneratorDefinition, UnitDefinition } from "../../clients/generators";
import { rtd } from "../../testing/fixtures";

function unit(name: string, node: string, capacity: number): UnitDefinition {
  return { name, unitCode: node.split(" ")[1], node, capacity, fuel: "Solar", fuelCode: "SOL" };
}

const generators: GeneratorDefinition[] = [{
  site: "RUK",
  name: "Ruakākā",
  units: [
    unit("Ruakākā Battery", "BRB0331 RUK0", 100),
    unit("Ruakākā Battery", "BRB0331 RUK99", -100),
    unit("Ruakākā Solar Farm", "BRB0331 RUS0", 130),
    unit("Ruakākā Unknown", "BRB0331 RUX0", 0),
  ],
  location: { lat: 0, long: 0 },
  gridZone: "NIS",
  operator: "Meridian Energy",
}];

describe("findUnitsOverCapacity", () => {
  it("finds units generating more than 1% over their capacity", () => {
    const dispatch = [
      rtd("BRB0331 RUS0", 132, 0, 100),
      rtd("BRB0331 RUK0", 100.9, 0, 100),
    ];

    expect(findUnitsOverCapacity(dispatch, generators)).toEqual([
      { node: "BRB0331 RUS0", name: "Ruakākā Solar Farm", mw: 132, capacity: 130 },
    ]);
  });

  it("ignores units without a positive capacity, and nodes that aren't in the generator list", () => {
    const dispatch = [
      rtd("BRB0331 RUK99", 5, 50, 100),
      rtd("BRB0331 RUX0", 5, 0, 100),
      rtd("XYZ2201 XYZ0", 500, 0, 100),
      rtd("BRB0331", 50, 0, 100),
    ];

    expect(findUnitsOverCapacity(dispatch, generators)).toEqual([]);
  });
});

describe("formatUnitsOverCapacityMessage", () => {
  it("lists each unit with its capacity", () => {
    const message = formatUnitsOverCapacityMessage([
      { node: "WAI0331 HTR0", name: "Te Herenga o Te Rā", mw: 34, capacity: 33 },
      { node: "WWD1102 WWD0", name: "West Wind", mw: 97.13, capacity: 71.3 },
    ]);

    expect(message).toBe(
      "⚠️ *Te Herenga o Te Rā* (`WAI0331 HTR0`) is generating *34 MW*, above its capacity of 33 MW in the generator list\n" +
      "⚠️ *West Wind* (`WWD1102 WWD0`) is generating *97.1 MW*, above its capacity of 71.3 MW in the generator list"
    );
  });
});
