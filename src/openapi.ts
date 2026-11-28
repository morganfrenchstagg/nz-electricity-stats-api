import { OpenAPIHono, z } from "@hono/zod-openapi";

// the routes are described with zod schemas (see createRoute in each api), and the OpenAPI document served at
// /openapi.json is generated from them, with these fields of its own. Swagger UI renders it at /docs

// the swagger-ui-dist release /docs loads from jsdelivr, pinned so the page doesn't change under us
export const SWAGGER_UI_VERSION = "5.35.0";

export const DOCUMENT_CONFIG = {
  openapi: "3.1.0",
  info: {
    title: "NZ Electricity Stats API",
    version: "1",
    description:
      "New Zealand's electricity market: real-time and historical dispatch and prices by node, energy aggregated by " +
      "day, week, month and year back to 1997, generators' offers, generation outages, the HVDC, and the stations, " +
      "substations and transmission lines.\n\n" +
      "The data is republished from the Electricity Authority's EMI, Transpower and em6. `GET /v1/attribution` lists " +
      "each source and the credit to give it, and every `/v1` response links to it with a " +
      '`Link: </v1/attribution>; rel="license"` header. There\'s no authentication.\n\n' +
      "Agents can also use the MCP server at `/mcp`, whose tools answer questions from these routes.",
  },
  tags: [
    {
      name: "Reference",
      description: "Stations, substations, transmission lines and where the data comes from",
    },
    { name: "Dispatch", description: "Each node's generation, load and price, by interval" },
    {
      name: "Generators",
      description:
        "A station's units' generation, prices and outages on a day, with the station itself",
    },
    { name: "Aggregates", description: "Each node's energy by day, week, month or year" },
    { name: "Offers", description: "Generators' energy offers" },
    { name: "Outages", description: "Generation outages from Transpower's POCP" },
  ],
};

// an app whose routes are described for the document. a request whose params or query don't match its route's
// schemas gets a 400 with the first problem's message, as the routes' own errors have
export function createApi() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ message: result.error.issues[0].message }, 400);
      }
    },
  });
}

export const MessageSchema = z.object({ message: z.string() }).openapi("Message");

export function json<T extends z.ZodType>(description: string, schema: T) {
  return { description, content: { "application/json": { schema } } };
}

export function message(description: string) {
  return json(description, MessageSchema);
}
