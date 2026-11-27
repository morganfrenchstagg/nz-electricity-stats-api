import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { round, runTool, ToolInputError } from "../api";
import { parseEnd, parseStart, todayInNz } from "../dates";
import {
  GENERATION_GROUPS,
  GenerationGroup,
  generationGroupOf,
  getAllSubstations,
  getAllUnits,
  matchesUnitFilter,
  normaliseName,
  UnitFilter,
  UnitInfo,
  validateUnitFilter,
} from "../nodes";
import { unitFilterShape } from "../schemas";
import { isInService } from "./live";
import generators from "../../data/generators.json" with { type: "json" };

// the most stations a search lists in full
const MAX_STATIONS = 25;

export type SearchArgs = UnitFilter & {
  query?: string;
  include_retired?: boolean;
};

export type CapacityArgs = UnitFilter & {
  as_of?: string;
  group_by?: GenerationGroup;
  changes_since?: string;
};

export function registerGeneratorTools(server: McpServer) {
  server.registerTool(
    "search_generators",
    {
      title: "Find generating stations and substations",
      description:
        "Looks up generating stations and their units (node codes, fuel, capacity, operator, island, when commissioned and " +
        "retired), and substations by name or site code. Use it to find the names and codes the other tools filter by, or for " +
        "questions about the stations themselves, e.g. 'Who owns Clyde?', 'When was Te Mihi commissioned?' or 'What batteries are there?'.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Part of a station, unit, scheme, operator or substation name (macrons optional), or a site or node code",
          ),
        include_retired: z
          .boolean()
          .optional()
          .describe("Include retired units and stations. Defaults to false"),
        ...unitFilterShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(async () => searchGenerators(args)),
  );

  server.registerTool(
    "get_generating_capacity",
    {
      title: "Generating capacity",
      description:
        "The grid's generating capacity (MW) in service on a date, by fuel, island, operator, station and so on, and the units " +
        "commissioned and retired since another date. Use it for questions like 'How much wind capacity is there?', 'How has solar " +
        "capacity grown since 2023?' or 'What was the thermal capacity in 2010?'.",
      inputSchema: {
        as_of: z
          .string()
          .optional()
          .describe("YYYY, YYYY-MM or YYYY-MM-DD (its last day). Defaults to today"),
        group_by: z.enum(GENERATION_GROUPS).optional().describe("Defaults to fuel"),
        changes_since: z
          .string()
          .optional()
          .describe(
            "Also list the units commissioned or retired after this date (YYYY, YYYY-MM or YYYY-MM-DD, its first day) up to as_of",
          ),
        ...unitFilterShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(async () => getGeneratingCapacity(args)),
  );
}

export function searchGenerators(args: SearchArgs) {
  validateUnitFilter(args);
  const query = args.query ? normaliseName(args.query) : undefined;
  const now = new Date();

  const stations = generators
    .map((generator) => {
      const units = getAllUnits().filter(
        (unit) =>
          unit.site === generator.site &&
          unit.station === generator.name &&
          (args.include_retired || !isRetired(unit, now)) &&
          matchesUnitFilter(unit, args),
      );
      const matchesQuery =
        !query ||
        [
          generator.name,
          generator.site,
          generator.operator,
          "scheme" in generator ? generator.scheme : "",
          ...units.flatMap((unit) => [unit.unit, unit.node]),
        ].some((name) => normaliseName(name ?? "").includes(query));
      return matchesQuery && units.length > 0
        ? {
            station: generator.name,
            site: generator.site,
            operator: generator.operator,
            ...("scheme" in generator ? { scheme: generator.scheme } : {}),
            island: units[0].island,
            gridZone: generator.gridZone,
            location: generator.location,
            units: units.map((unit) => ({
              unit: unit.unit,
              node: unit.node,
              fuel: unit.fuel,
              capacityMW: unit.capacity,
              ...(unit.commissioned
                ? { commissioned: todayInNz(new Date(unit.commissioned)) }
                : { commissioned: "being commissioned" }),
              ...(unit.decommissioned ? { retired: todayInNz(new Date(unit.decommissioned)) } : {}),
              ...(unit.combines
                ? {
                    combines: unit.combines,
                    note: "Stands in for these units in the metered data before they're separated",
                  }
                : {}),
            })),
          }
        : null;
    })
    .filter((station) => station !== null);

  const substations = query
    ? getAllSubstations()
        .filter(
          (substation) =>
            normaliseName(substation.description).includes(query) ||
            substation.siteId.toLowerCase() === query,
        )
        .map((substation) => ({
          siteId: substation.siteId,
          name: substation.description,
          island: substation.island,
        }))
    : [];

  if (stations.length === 0 && substations.length === 0) {
    throw new ToolInputError(
      "Nothing matched. Try part of a name without macrons (e.g. Manapouri), or fewer filters",
    );
  }

  return {
    matchingStations: stations.length,
    stations: stations.slice(0, MAX_STATIONS),
    ...(stations.length > MAX_STATIONS
      ? {
          note: `Only the first ${MAX_STATIONS} stations are listed. Narrow the search to see the rest`,
        }
      : {}),
    ...(substations.length > 0 ? { substations: substations.slice(0, MAX_STATIONS) } : {}),
  };
}

export function getGeneratingCapacity(args: CapacityArgs) {
  validateUnitFilter(args);
  const groupBy = args.group_by ?? "fuel";
  const asOf = args.as_of ? parseEnd(args.as_of) : todayInNz();
  // the end of the day in NZ, near enough for a commissioning date
  const at = new Date(Date.parse(`${asOf}T23:59:59+12:00`));

  const inService = getAllUnits().filter(
    (unit) => isInService(unit, at) && matchesUnitFilter(unit, args),
  );
  const groups = new Map<string, { capacityMW: number; units: number; stations: Set<string> }>();
  for (const unit of inService) {
    const name = generationGroupOf(unit, groupBy);
    const group = groups.get(name) ?? { capacityMW: 0, units: 0, stations: new Set() };
    group.capacityMW += unit.capacity;
    group.units++;
    group.stations.add(unit.station);
    groups.set(name, group);
  }
  const total = inService.reduce((sum, unit) => sum + unit.capacity, 0);

  let changes;
  if (args.changes_since) {
    const since = parseStart(args.changes_since);
    const between = (date: string | undefined) =>
      date !== undefined && todayInNz(new Date(date)) >= since && todayInNz(new Date(date)) <= asOf;
    const units = getAllUnits().filter(
      (unit) => !unit.charging && !unit.combines && matchesUnitFilter(unit, args),
    );
    const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
    changes = {
      since,
      commissioned: units
        .filter((unit) => between(unit.commissioned))
        .map((unit) => describeChange(unit, unit.commissioned!))
        .sort(byDate),
      retired: units
        .filter((unit) => between(unit.decommissioned))
        .map((unit) => describeChange(unit, unit.decommissioned!))
        .sort(byDate),
    };
  }

  return {
    asOf,
    unit: "MW",
    groupBy,
    groups: [...groups]
      .sort(([, a], [, b]) => b.capacityMW - a.capacityMW)
      .map(([name, group]) => ({
        group: name,
        capacityMW: round(group.capacityMW, 1),
        share: round((group.capacityMW / total) * 100, 1),
        units: group.units,
        stations: group.stations.size,
      })),
    totalMW: round(total, 1),
    ...(changes ? { changes } : {}),
    ...(asOf >= todayInNz()
      ? {
          beingCommissioned: getAllUnits()
            .filter((unit) => !unit.commissioned && matchesUnitFilter(unit, args))
            .map((unit) => ({
              unit: unit.unit,
              station: unit.station,
              fuel: unit.fuel,
              capacityMW: unit.capacity,
            })),
        }
      : {}),
    notes: [
      "Capacity is each grid-dispatched unit's capacity in the dispatch, so it leaves out rooftop solar and most small embedded generation. " +
        "Batteries are counted at their discharging capacity.",
      "Units that were running before EMI's plant register began are dated from roughly when they first generated, and units retired " +
        "before 1997 aren't listed, so capacity long before then is approximate.",
    ],
  };
}

function isRetired(unit: UnitInfo, now: Date): boolean {
  return unit.decommissioned !== undefined && Date.parse(unit.decommissioned) <= now.getTime();
}

function describeChange(unit: UnitInfo, date: string) {
  return {
    date: todayInNz(new Date(date)),
    unit: unit.unit,
    station: unit.station,
    fuel: unit.fuel,
    capacityMW: unit.capacity,
    operator: unit.operator,
  };
}
