import { z } from "zod";

// the arguments the tools share, so they're described the same way everywhere

export const unitFilterShape = {
	fuel: z.array(z.string()).optional()
		.describe("Only these fuels: Hydro, Geothermal, Gas, Coal/Gas (Huntly's Rankine units), Wind, Solar, Battery, Diesel"),
	operator: z.array(z.string()).optional()
		.describe("Only these operators. Part of a name matches, e.g. Meridian, Contact, Genesis, Mercury"),
	island: z.enum(["North", "South"]).optional(),
	station: z.array(z.string()).optional()
		.describe("Only these stations, by name (part of one matches, without macrons, e.g. Manapouri or Ohau), site code (e.g. HLY) or node (e.g. HLY2201 HLY5)"),
};

export const topSchema = z.number().int().min(1).max(100).optional()
	.describe("How many groups to list, largest first. The rest are summed into an Other column. Defaults to 15");

export const DEFAULT_TOP = 15;
