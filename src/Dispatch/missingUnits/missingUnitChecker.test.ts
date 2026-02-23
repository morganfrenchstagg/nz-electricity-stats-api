import { checkForMissingUnits } from "./missingUnitChecker";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGenerators } from ".././generators";
import { getSubstations } from ".././substations";

vi.mock(".././generators");
vi.mock(".././substations");

const mockedGetGenerators = vi.mocked(getGenerators);
const mockedGetSubstations = vi.mocked(getSubstations);

describe("checkForMissingUnits", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should return an empty array if there are no generators", async () => {
    mockedGetGenerators.mockResolvedValue([]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits([]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: [],
      },
    });
  });

  it("should return an empty array if there are no missing units", async () => {
    mockedGetGenerators.mockResolvedValue([
      {
        units: [
          {
            node: "1234567890 ABCD",
          },
        ],
      },
    ]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits(["1234567890 ABCD"]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: [],
      },
    });
  });

  it("should return an array of missing units if there are missing units in the dispatch list", async () => {
    mockedGetGenerators.mockResolvedValue([
      {
        units: [
          {
            node: "1234567890 ABCD",
          },
        ],
      },
    ]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits([]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: ["1234567890 ABCD"],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: [],
      },
    });
  });

  it("should return an empty array of missing units if there are missing units in the dispatch list but the unit is listed as inactive in the generator list", async () => {
    mockedGetGenerators.mockResolvedValue([
      {
        units: [
          {
            node: "1234567890 ABCD",
            active: false,
          },
        ],
      },
    ]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits([]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: [],
      },
    });
  });

  it("should return an array of units not in the generator list if there are units not in the generator list", async () => {
    mockedGetGenerators.mockResolvedValue([]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits(["1234567890 ABCD"]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: ["1234567890 ABCD"],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: [],
      },
    });
  });

  it("should satisfy both conditions if there are missing units and units not in the generator list", async () => {
    mockedGetGenerators.mockResolvedValue([
      {
        units: [
          {
            node: "1234567890 ABCD",
          },
        ],
      },
    ]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits(["9876543210 ABCD"]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: ["1234567890 ABCD"],
        notInGeneratorList: ["9876543210 ABCD"],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: [],
      },
    });
  });

  it("should not include substation units in the generator list", async () => {
    mockedGetGenerators.mockResolvedValue([
      {
        units: [
          {
            node: "1234567890 ABCD",
          },
        ],
      },
    ]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits([
      "1234567890",
      "1234567890 ABCD",
    ]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: ["1234567890"],
      },
    });
  });

  it("should show missing substation units if there are missing substation units in the dispatch list", async () => {
    mockedGetGenerators.mockResolvedValue([]);
    mockedGetSubstations.mockResolvedValue([
      {
        siteId: "1234567890",
        lat: 0,
        long: 0,
        description: "",
        type: "ACSTN",
        gridZone: 0,
        island: "north",
      },
    ]);

    const result = await checkForMissingUnits([]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: ["1234567890"],
        notInSubstationList: [],
      },
    });
  });

  it("should show missing substation units if there are missing substation units in the substation list", async () => {
    mockedGetGenerators.mockResolvedValue([]);
    mockedGetSubstations.mockResolvedValue([]);

    const result = await checkForMissingUnits(["1234567890"]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: [],
        notInGeneratorList: [],
      },
      substations: {
        notInDispatchList: [],
        notInSubstationList: ["1234567890"],
      },
    });
  });

  it("should satisfy all conditions", async () => {
    mockedGetGenerators.mockResolvedValue([
      {
        units: [
          {
            node: "1234567890 ABCD",
          },
        ],
      },
    ]);
    mockedGetSubstations.mockResolvedValue([
      {
        siteId: "1234567890",
        lat: 0,
        long: 0,
        description: "",
        type: "ACSTN",
        gridZone: 0,
        island: "north",
      },
    ]);

    const result = await checkForMissingUnits([
      "9876543210 ABCD",
      "9876543210",
    ]);
    expect(result).toEqual({
      generation: {
        notInDispatchList: ["1234567890 ABCD"],
        notInGeneratorList: ["9876543210 ABCD"],
      },
      substations: {
        notInDispatchList: ["1234567890"],
        notInSubstationList: ["9876543210"],
      },
    });
  });
});
