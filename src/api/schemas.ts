import { z } from "@hono/zod-openapi";

// the schemas more than one api's responses use. the ones named with .openapi("Name") are listed in the document's
// components and referred to from each route that uses them

export const nzTime = z
  .string()
  .openapi({ description: "An NZ time, without an offset", example: "2026-10-14T21:55:00" });

export const nzDate = z.string().openapi({ format: "date", example: "2026-10-14" });

// a timeseries row: its time (or date), then a value for each of the series, in order. zod-to-openapi leaves a tuple's
// rest element out of the document, so it's described in the metadata as well
export function timeseriesRow(first: z.ZodString) {
  return z.tuple([first], z.number()).openapi({ items: { type: "number" } });
}

export function nullableTimeseriesRow(first: z.ZodString) {
  return z.tuple([first], z.number().nullable()).openapi({ items: { type: ["number", "null"] } });
}

export const nodeList = z.array(z.string()).openapi({
  description:
    "The nodes, in the order of each row's values: units by point of connection and unit code (e.g. `HLY2201 HLY5`), " +
    "and points of connection's load (e.g. `ABY0111`)",
  example: ["ABY0111", "HLY2201 HLY5"],
});

export const HvdcTimeseriesSchema = z
  .object({
    series: z.array(
      z.string().openapi({ enum: ["northFlow", "southFlow", "northLimit", "southLimit"] }),
    ),
    data: z
      .array(nullableTimeseriesRow(nzTime))
      .openapi({ example: [["2026-10-14T21:30:00", 410, 0, 1200, -850]] }),
  })
  .openapi("HvdcTimeseries", {
    description:
      "The HVDC's flows and transfer limits in each half hour (MW). em6 gives the south limit as negative. " +
      "Empty when there's no data for the day",
  });

// the generators and substations come from JSON files, whose strings TypeScript can't narrow to these enums, so they're
// strings with their values listed in the document rather than z.enum. the tests check the files against it

export const UnitSchema = z
  .object({
    name: z.string().openapi({ example: "Ātiamuri" }),
    unitCode: z.string().openapi({ example: "ATI0" }),
    node: z.string().openapi({
      description: "Its node in the dispatch data: point of connection and unit code",
      example: "ATI2201 ATI0",
    }),
    capacity: z.number().openapi({ description: "MW" }),
    installedCapacity: z.number().optional().openapi({
      description: "MW installed, where it's more than it can generate (e.g. Manapōuri)",
    }),
    outageBlock: z.string().optional().openapi({
      description: "Its outage block in POCP, where that doesn't follow from its unit code",
    }),
    fuel: z.string().openapi({
      enum: [
        "Hydro",
        "Geothermal",
        "Gas",
        "Coal/Gas",
        "Wind",
        "Solar",
        "Diesel",
        "Battery (Charging)",
        "Battery (Discharging)",
      ],
    }),
    fuelCode: z.string().openapi({
      enum: ["HYD", "GEO", "GAS", "CLG", "WIN", "SOL", "DIE", "BESS", "BESS-C"],
    }),
    commissioned: z.string().optional().openapi({
      format: "date-time",
      description: "When it began generating. Absent while it's still being commissioned",
    }),
    decomissioned: z.string().optional().openapi({
      format: "date-time",
      description: "When it stopped. Absent while it's in service",
    }),
    combines: z
      .array(z.string())
      .optional()
      .openapi({
        description:
          "The nodes of the units it stands in for in metered data from before the dispatch data, where the metered " +
          "data doesn't separate them (e.g. Huntly's Rankine units before 2000)",
      }),
  })
  .openapi("Unit");

export const UnitOutageSchema = z
  .object({
    outageBlock: z.string(),
    mwLost: z.number(),
    mwRemain: z.number(),
    from: z.string().openapi({ format: "date-time" }),
    until: z.string().openapi({ format: "date-time" }),
  })
  .openapi("UnitOutage", { description: "A generation outage from POCP" });

export const GeneratorSchema = z
  .object({
    site: z.string().openapi({ description: "Site code", example: "ATI" }),
    name: z.string().openapi({ example: "Ātiamuri" }),
    units: z.array(UnitSchema),
    location: z.object({ lat: z.number(), long: z.number() }),
    gridZone: z.string().openapi({
      enum: ["UNI", "CNI", "LNI", "USI", "LSI"],
      description: "The upper, central or lower North Island, or upper or lower South Island",
    }),
    island: z.string().openapi({ enum: ["NI", "SI"] }),
    operator: z.string().openapi({ example: "Mercury" }),
    secondaryOperator: z.string().optional().openapi({
      description: "Who else operates or owns it",
      example: "Tuaropaki Power Company",
    }),
    scheme: z.string().optional().openapi({ example: "Waikato River Hydro Scheme" }),
    alias: z.string().optional().openapi({
      description: "Another site code it's known by, e.g. in POCP's outage blocks",
      example: "TCC",
    }),
  })
  .openapi("Generator", { description: "A generating station" });

export const SubstationSchema = z
  .object({
    lat: z.number(),
    long: z.number(),
    siteId: z.string().openapi({ example: "ALB" }),
    description: z.string().openapi({ example: "Albany" }),
    type: z.string().openapi({
      enum: ["ACSTN", "TEE"],
      description: "An AC station, or a tee where lines join",
    }),
    gridZone: z.number().int().min(1).max(14),
    island: z.string().openapi({ enum: ["north", "south"] }),
  })
  .openapi("Substation");
