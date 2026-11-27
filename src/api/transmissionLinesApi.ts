import { createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { fetchTransmissionLinesFromArcgis } from "../clients/transmissionLines";
import { TRANSMISSION_LINES_MAX_AGE_SECONDS } from "../services/transmissionLines/transmissionLines";
import { edgeCache } from "../utilities/edgeCache";
import { createApi, json } from "../openapi";

const app = createApi();
app.use(cors());

const TransmissionLinesSchema = z
  .object({
    type: z.literal("FeatureCollection"),
    features: z.array(
      z.object({
        type: z.literal("Feature"),
        geometry: z
          .object({
            type: z.string().openapi({ enum: ["LineString", "MultiLineString"] }),
            coordinates: z.array(z.unknown()),
          })
          .nullable()
          .openapi({ description: "A LineString or MultiLineString, in WGS 84" }),
        properties: z.object({
          MXLOCATION: z.string().openapi({ example: "AHA-DOB-A" }),
          designvolt: z.string().openapi({ description: "kV", example: "66" }),
          status: z.string().openapi({ example: "COMMISSIONED" }),
          description: z.string().openapi({ example: "Arahura - Dobson A" }),
          type: z.string().openapi({ example: "TRANSLINE" }),
        }),
      }),
    ),
  })
  .openapi("TransmissionLines");

const transmissionLinesRoute = createRoute({
  method: "get",
  path: "/",
  middleware: [edgeCache] as const,
  tags: ["Reference"],
  operationId: "getTransmissionLines",
  summary: "The grid's transmission lines",
  description:
    "Transpower's lines and cables as GeoJSON, simplified to within about 5m. They rarely change, so are cached for a day.",
  responses: {
    200: {
      description: "The lines",
      content: { "application/geo+json": { schema: TransmissionLinesSchema } },
    },
    502: json("ArcGIS is unavailable", z.object({ error: z.string() })),
  },
});

// a proxy to ArcGIS, with the edge cache keeping each data center to about one request a day. the lines rarely change
app.openapi(transmissionLinesRoute, async (c) => {
  try {
    const body = await fetchTransmissionLinesFromArcgis();
    return c.json(JSON.parse(body), 200, {
      "Content-Type": "application/geo+json",
      "Cache-Control": `public, max-age=${TRANSMISSION_LINES_MAX_AGE_SECONDS}`,
    });
  } catch (e) {
    console.error("Failed to load transmission lines", e);
    return c.json({ error: "Transmission lines are temporarily unavailable" }, 502, {
      "Cache-Control": "no-store",
    });
  }
});

export default app;
