import { env } from "cloudflare:workers";
import { createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import {
  getServiceUnavailableResponse,
  ONE_DAY_IN_SECONDS,
  ONE_HOUR_IN_SECONDS,
} from "../utilities/utilities";
import { createApi, json, message } from "../openapi";

const app = createApi();
app.use(cors());

const OffersSchema = z
  .object({
    date: z.string().openapi({ example: "20261014" }),
    data: z
      .record(
        z.string(),
        z.record(
          z.string(),
          z.array(
            z.object({
              tranche: z.number().int(),
              megawatts: z.number(),
              price: z.number().openapi({ description: "$/MWh" }),
            }),
          ),
        ),
      )
      .openapi({
        description:
          "By trading period (1-50) then unit node, the tranches offering more than 0 MW. Each is what was offered in " +
          "it, so a unit's can add up to more than its forecast",
        example: { 37: { "WWD1102 WWD1": [{ tranche: 1, megawatts: 30, price: 0.01 }] } },
      }),
    fogp: z.record(z.string(), z.record(z.string(), z.number())).openapi({
      description:
        "Intermittent units' forecast of generation potential (MW), by trading period then unit node. Empty before " +
        "24 October 2019, and for older days that haven't been backfilled yet",
      example: { 37: { "WWD1102 WWD1": 42.5 } },
    }),
  })
  .openapi("Offers");

type Offers = z.infer<typeof OffersSchema>;

const offersRoute = createRoute({
  method: "get",
  path: "/{date}",
  tags: ["Offers"],
  operationId: "getOffers",
  summary: "A day's energy offers",
  description:
    "Each unit's energy offers in each trading period, and intermittent units' forecasts of generation potential " +
    "(FOGP). EMI publishes them about a day after.",
  request: {
    params: z.object({
      date: z.string().openapi({
        description: "An NZ day, as YYYY-MM-DD or YYYYMMDD, or `latest` for the latest one synced",
        example: "latest",
      }),
    }),
  },
  responses: {
    200: json("The day's offers", OffersSchema),
    404: message("No data for this date"),
    503: message("Offers have not been synced yet"),
  },
});

app.openapi(offersRoute, async (c) => {
  let date = c.req.valid("param").date;

  if (date === "latest") {
    const latestSyncedOffers = await env.dispatch_kv.get("latestSyncedOffers");
    if (!latestSyncedOffers) {
      return getServiceUnavailableResponse(c, "Offers have not been synced yet");
    }
    date = latestSyncedOffers;
  }

  const formattedDate = date.replace(/-/g, "");
  const [data, fogp] = await Promise.all([
    env.offers.get("offers-" + formattedDate),
    env.offers.get("fogp-" + formattedDate),
  ]);

  if (!data) {
    return c.json({ message: "No data for this date" }, 404);
  }

  const response = {
    date: formattedDate,
    data: await data.json<Offers["data"]>(),
    // intermittent units' forecast of generation potential, by trading period and unit. EMI's offers only have it
    // from 24 October 2019, and the days synced before late October 2026 have none until they're backfilled (see
    // backfillFogp)
    fogp: fogp ? await fogp.json<Offers["fogp"]>() : {},
  };

  // todo - better calculate an appropriate amount of time for this cache to last
  const maxAgeSeconds = c.req.param("date") === "latest" ? ONE_HOUR_IN_SECONDS : ONE_DAY_IN_SECONDS;

  return c.json(response, 200, { "Cache-Control": `max-age=${maxAgeSeconds}` });
});

export default app;
