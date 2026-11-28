import { createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import dispatchApi from "./api/dispatchApi";
import generatorsApi from "./api/generatorsApi";
import { getGenerators } from "./clients/generators";
import { getSubstations } from "./clients/substations";
import offersApi from "./api/offersApi";
import { ONE_DAY_IN_SECONDS } from "./utilities/utilities";
import outagesApi from "./api/outagesApi";
import transmissionLinesApi from "./api/transmissionLinesApi";
import { ATTRIBUTION, ATTRIBUTION_LINK } from "./attribution";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp/mcpServer";
import { createApi, DOCUMENT_CONFIG, json, SWAGGER_UI_VERSION } from "./openapi";
import { GeneratorSchema, SubstationSchema } from "./api/schemas";

const app = createApi();

app.use(cors());

// catches anything the routes (including the mounted sub-apps) don't handle themselves, so callers get a JSON
// body instead of Hono's plain-text 500
app.onError((err, c) => {
  console.error(`Unhandled error for ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: "Internal server error" }, 500, { "Cache-Control": "no-store" });
});

// every data response points to where its sources and licences are credited (see attribution.ts)
app.use("/v1/*", async (c, next) => {
  await next();
  c.header("Link", ATTRIBUTION_LINK, { append: true });
});

app.get("/", async (c) => {
  return c.body(null, 200);
});

app.get("ping", async (c) => {
  return c.text("pong");
});

// generated from the routes' schemas the first time it's asked for, with the server set to wherever it's requested
// from, so Swagger UI's "Try it out" requests the same deployment (or wrangler dev). it isn't cached, so /docs has the
// routes as soon as they're deployed
let openApiDocument: ReturnType<typeof app.getOpenAPI31Document> | undefined;

app.get("/openapi.json", async (c) => {
  openApiDocument ??= app.getOpenAPI31Document(DOCUMENT_CONFIG);
  return c.json({ ...openApiDocument, servers: [{ url: new URL(c.req.url).origin }] }, 200, {
    "Cache-Control": "no-cache",
  });
});

app.get(
  "/docs",
  swaggerUI({
    url: "/openapi.json",
    title: "NZ Electricity Stats API",
    version: SWAGGER_UI_VERSION,
  }),
);

const CACHED_FOR_A_DAY = { "Cache-Control": `max-age=${ONE_DAY_IN_SECONDS}` };

const namedLink = z.object({ name: z.string(), url: z.url() });

const AttributionSchema = z
  .object({
    sources: z.array(
      z.object({
        data: z.string().openapi({ description: "The data that comes from the source" }),
        endpoints: z.array(z.string()).openapi({
          description: "The routes that return it",
          example: ["/v1/dispatch", "/v1/offers"],
        }),
        source: namedLink,
        copyright: z.object({ holder: z.string(), url: z.url() }).optional(),
        licence: namedLink.optional(),
        credit: z.string().openapi({ description: "The credit to give it" }),
      }),
    ),
    disclaimer: z.string(),
  })
  .openapi("Attribution");

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/attribution",
    tags: ["Reference"],
    operationId: "getAttribution",
    summary: "Where the data comes from",
    description:
      "Each data source, which routes use it, and the credit to give it when re-using its data.",
    responses: { 200: json("The sources", AttributionSchema) },
  }),
  async (c) => {
    return c.json(ATTRIBUTION, 200, CACHED_FOR_A_DAY);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/definitions",
    tags: ["Reference"],
    operationId: "getDefinitions",
    summary: "Generators and substations",
    description: "`/v1/generators` and `/v1/substations` in one response.",
    responses: {
      200: json(
        "The generators and substations",
        z.object({ generators: z.array(GeneratorSchema), substations: z.array(SubstationSchema) }),
      ),
    },
  }),
  async (c) => {
    const generators = await getGenerators();
    const substations = await getSubstations();

    const output = {
      generators,
      substations,
    };

    return c.json(output, 200, CACHED_FOR_A_DAY);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/substations",
    tags: ["Reference"],
    operationId: "listSubstations",
    summary: "Grid substations",
    responses: { 200: json("The substations", z.array(SubstationSchema)) },
  }),
  async (c) => {
    return c.json(await getSubstations(), 200, CACHED_FOR_A_DAY);
  },
);

app.route("/v1/generators", generatorsApi);
app.route("/v1/dispatch", dispatchApi);
app.route("/v1/offers", offersApi);
app.route("/v1/outages", outagesApi);
app.route("/v1/transmission-lines", transmissionLinesApi);

// an MCP server whose tools answer agents' questions from the routes above, requesting them from the worker itself
// rather than over the network. it's stateless, so each request gets a server of its own
app.post("/mcp", async (c) => {
  const server = createMcpServer(async (path) =>
    app.fetch(new Request(new URL(path, c.req.url)), c.env, c.executionCtx),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// a stateless server has no stream for the client to open, or session for it to end
app.on(["GET", "DELETE"], "/mcp", async (c) => {
  return c.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
    405,
    { Allow: "POST" },
  );
});

export default app;
