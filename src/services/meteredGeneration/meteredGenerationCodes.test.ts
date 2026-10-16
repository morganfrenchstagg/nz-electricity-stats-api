import { describe, expect, it } from "vitest";

import generators from "../../data/generators.json" with { type: "json" };
import { UnitDefinition } from "../../clients/generators";
import { METERED_GENERATION_CODES } from "./meteredGeneration";

// checks meteredGenerationCodes.json against generators.json, so a unit can't be renamed, moved or removed without
// updating the metered generation attributed to it
const units: UnitDefinition[] = generators.flatMap(generator => generator.units);
const nodes = new Set(units.map(unit => unit.node));

describe("meteredGenerationCodes.json", () => {
  it("lists each code as its point of connection and lowercased generator code", () => {
    for (const { code } of METERED_GENERATION_CODES) {
      expect(code).toMatch(/^[A-Z]{3}\d{4} [^\sA-Z]+$/);
    }
  });

  it("attributes each code to a unit or says why it's excluded", () => {
    for (const entry of METERED_GENERATION_CODES) {
      expect([entry.node, entry.excluded].filter(Boolean), entry.code).toHaveLength(1);
    }
  });

  it("only attributes generation to units in generators.json", () => {
    const missing = METERED_GENERATION_CODES.filter(entry => entry.node && !nodes.has(entry.node));
    expect(missing).toEqual([]);
  });

  it("doesn't attribute a code to more than one unit on the same day", () => {
    const byCode = Map.groupBy(METERED_GENERATION_CODES, entry => entry.code);

    for (const [code, entries] of byCode) {
      const ranges = entries
        .map(entry => ({ from: entry.from ?? "0000-00-00", to: entry.to ?? "9999-99-99" }))
        .sort((a, b) => a.from.localeCompare(b.from));

      for (const range of ranges) {
        expect(range.from <= range.to, code).toBe(true);
      }
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i - 1].to < ranges[i].from, code).toBe(true);
      }
    }
  });

  it("is in code order", () => {
    const codes = METERED_GENERATION_CODES.map(entry => entry.code);
    expect(codes).toEqual([...codes].sort());
  });
});

describe("units only in the metered generation", () => {
  // units whose node is a metered code (lowercase), e.g. HLY2201 huntly_1_4, rather than one from the dispatch data
  const meteredUnits = units.filter(unit => /[a-z]/.test(unit.node));

  it("are each attributed the metered code they're named after", () => {
    const attributed = new Set(METERED_GENERATION_CODES.filter(entry => entry.node === entry.code).map(entry => entry.node));
    expect(meteredUnits.length).toBeGreaterThan(0);
    for (const unit of meteredUnits) {
      expect(attributed.has(unit.node), unit.node).toBe(true);
    }
  });

  it("finished before the dispatch data began", () => {
    for (const unit of meteredUnits) {
      expect(unit.decomissioned! < "2020-09-11", unit.node).toBe(true);
    }
  });
});

describe("units combining others' metered generation", () => {
  const combinedUnits = units.filter(unit => unit.combines);

  it("combine units in generators.json", () => {
    for (const unit of combinedUnits) {
      expect(unit.combines!.filter(node => !nodes.has(node)), unit.node).toEqual([]);
    }
  });

  it("were commissioned with the oldest unit they combine", () => {
    const commissioned = new Map(units.map(unit => [unit.node, unit.commissioned]));
    for (const unit of combinedUnits) {
      expect(unit.commissioned, unit.node).toBe(unit.combines!.map(node => commissioned.get(node)!).sort()[0]);
    }
  });

  it("have no capacity of their own, as the units they combine have it", () => {
    for (const unit of combinedUnits) {
      expect(unit.capacity, unit.node).toBe(0);
    }
  });
});
