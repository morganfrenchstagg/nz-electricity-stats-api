import { env } from "cloudflare:workers";
import { Validator } from "@cfworker/json-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "./app";
import { DOCUMENT_CONFIG, SWAGGER_UI_VERSION } from "./openapi";
import { requestWorker } from "./testing/requestWorker";
import { HVDC_TIMESERIES, outage, rtd } from "./testing/fixtures";
import { HVDC_KEY } from "./sync/syncHvdc";
import { LATEST_AGGREGATED_DATE_KEY } from "./sync/syncDispatchAggregates";
import { getAggregateKey } from "./services/dispatchAggregation/dispatchAggregation";
import { HVDC_AGGREGATE_PREFIX } from "./services/hvdc/hvdc";
import { METERED_DAY_PREFIX } from "./services/meteredGeneration/meteredGeneration";

// the routes that aren't part of the REST API: health checks, the MCP server (its tools are described by MCP itself),
// and the docs
const UNDOCUMENTED_PATHS = ["/", "/ping", "/mcp", "/openapi.json", "/docs"];

const document = app.getOpenAPI31Document(DOCUMENT_CONFIG) as any;

// e.g. /v1/dispatch/aggregates/:year{[0-9]{4}}/weekly is /v1/dispatch/aggregates/{year}/weekly
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:(\w+)(\{(?:[^{}]|\{[^{}]*\})*\})?/g, "{$1}");
}

// the documented schema of a route's response, with its $refs pointing at the components as $defs
function responseValidator(path: string, status: number) {
  const content = document.paths[path].get.responses[status].content;
  const { schema } = Object.values(content)[0] as { schema: object };
  const root = JSON.parse(
    JSON.stringify({ $defs: document.components.schemas, ...schema }).replaceAll(
      "#/components/schemas/",
      "#/$defs/",
    ),
  );
  return new Validator(root, "2020-12", false);
}

async function expectDocumentedResponse(url: string, path: string, status = 200) {
  const { response } = await requestWorker(url);
  expect(response.status).toBe(status);

  const { valid, errors } = responseValidator(path, status).validate(await response.json());
  expect(errors.slice(0, 5)).toEqual([]);
  expect(valid).toBe(true);
}

describe("GET /openapi.json", () => {
  it("returns the document generated from the routes, with the server it was requested from", async () => {
    const { response } = await requestWorker("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.json()).toEqual({ ...document, servers: [{ url: "https://api.test" }] });
  });
});

describe("GET /docs", () => {
  it("renders Swagger UI from the document", async () => {
    const { response } = await requestWorker("/docs");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('url: "/openapi.json"');
    expect(html).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`);
  });
});

describe("the OpenAPI document", () => {
  // a route added with app.get rather than app.openapi isn't in it
  it("documents every route the API serves", () => {
    const served = new Set(
      app.routes
        .filter((route) => route.method !== "ALL" && !UNDOCUMENTED_PATHS.includes(route.path))
        .map((route) => `${route.method} ${toOpenApiPath(route.path)}`),
    );
    const documented = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.keys(operations as object).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect([...served].sort()).toEqual(documented.sort());
  });

  it("has a unique operationId for each operation", () => {
    const ids = Object.values(document.paths).flatMap((operations) =>
      Object.values(operations as object).map((operation) => operation.operationId),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });
});

// the compiler checks what each route returns against its schemas, but much of the data is read from R2, KV or JSON
// files without a type it can check (e.g. the timeseries' rows, or the generators' fuels), so the responses that can
// be built from the bundled data or a fixture are checked against the document too
describe("documented responses", () => {
  beforeEach(() => {
    // 22:01 in NZ
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:01:00Z"));
  });

  it.each(["/v1/attribution", "/v1/generators", "/v1/substations", "/v1/definitions"])(
    "%s",
    async (path) => {
      await expectDocumentedResponse(path, path);
    },
  );

  it("/v1/dispatch/recent", async () => {
    await env.dispatch.put(
      "timeseries",
      JSON.stringify({
        series: ["ATI2201 ATI0", "ALB0331"],
        data: [["2026-10-14T22:00:00", 50, -20]],
        pricing: [["2026-10-14T22:00:00", 120.5, 130]],
      }),
    );
    await env.dispatch.put(HVDC_KEY, JSON.stringify(HVDC_TIMESERIES));

    await expectDocumentedResponse("/v1/dispatch/recent", "/v1/dispatch/recent");
  });

  it("/v1/dispatch/recent before the first sync", async () => {
    await expectDocumentedResponse("/v1/dispatch/recent", "/v1/dispatch/recent");
  });

  it("/v1/dispatch/recent with an invalid since", async () => {
    await expectDocumentedResponse("/v1/dispatch/recent?since=today", "/v1/dispatch/recent", 400);
  });

  it.each(["/v1/dispatch/latest", "/v1/dispatch/delta"])("%s", async (path) => {
    await env.dispatch_kv.put(
      "latestDispatch",
      JSON.stringify([rtd("ATI2201 ATI0", 50, 0, 120.5), rtd("ALB0331", 0, 20, 130)]),
    );
    await env.dispatch_kv.put(
      "latestOutages",
      JSON.stringify({ "ATI2201 ATI0": [outage("ATI_0")] }),
    );

    await expectDocumentedResponse(path, path);
  });

  it("/v1/dispatch/{date}", async () => {
    await env.dispatch.put(
      "dispatch-20261012",
      JSON.stringify({
        "2026-10-12T00:00:00": [
          { p: "ATI2201 ATI0", g: 50, l: 0, c: 120.5 },
          { p: "ALB0331", g: 0, l: 20, c: 130 },
        ],
      }),
    );

    await expectDocumentedResponse("/v1/dispatch/2026-10-12", "/v1/dispatch/{date}");
  });

  it("/v1/dispatch/{date} from metered data, without prices", async () => {
    await env.dispatch.put(
      `${METERED_DAY_PREFIX}20100101`,
      JSON.stringify({ "2010-01-01T00:00:00": [{ p: "ATI2201 ATI0", g: 50, l: 0 }] }),
    );

    await expectDocumentedResponse("/v1/dispatch/2010-01-01", "/v1/dispatch/{date}");
  });

  it("/v1/dispatch/{date} with no data", async () => {
    await expectDocumentedResponse("/v1/dispatch/2026-10-12", "/v1/dispatch/{date}", 404);
  });

  it("/v1/dispatch/aggregates", async () => {
    await env.dispatch_kv.put(LATEST_AGGREGATED_DATE_KEY, "2026-10-12");

    await expectDocumentedResponse("/v1/dispatch/aggregates", "/v1/dispatch/aggregates");
  });

  it("/v1/dispatch/aggregates/{year}/monthly", async () => {
    await env.dispatch.put(
      getAggregateKey("monthly", "2025"),
      JSON.stringify({
        data: [
          { from: "2025-01-01", to: "2025-01-31", nodes: { "ATI2201 ATI0": { g: 50, l: 0 } } },
        ],
      }),
    );
    await env.dispatch.put(
      getAggregateKey("monthly", "2025", HVDC_AGGREGATE_PREFIX),
      JSON.stringify({
        data: [
          {
            from: "2025-01-01",
            to: "2025-01-31",
            nodes: { northFlow: { g: 300, l: 0 }, southFlow: { g: 10, l: 0 } },
          },
        ],
      }),
    );

    await expectDocumentedResponse(
      "/v1/dispatch/aggregates/2025/monthly?nodes=ATI",
      "/v1/dispatch/aggregates/{year}/monthly",
    );
  });

  it("/v1/offers/{date}", async () => {
    await env.offers.put(
      "offers-20261012",
      JSON.stringify({ "1": { "ATI2201 ATI0": [{ tranche: 1, megawatts: 40, price: 0.01 }] } }),
    );
    await env.offers.put("fogp-20261012", JSON.stringify({ "1": { "WWD1102 WWD1": 63.5 } }));

    await expectDocumentedResponse("/v1/offers/2026-10-12", "/v1/offers/{date}");
  });

  it("/v1/outages", async () => {
    await env.dispatch_kv.put(
      "latestOutages",
      JSON.stringify({ "ATI2201 ATI0": [outage("ATI_0")] }),
    );

    await expectDocumentedResponse("/v1/outages", "/v1/outages");
  });

  it("/v1/outages/{date} with an invalid date", async () => {
    await expectDocumentedResponse("/v1/outages/2026-02-30", "/v1/outages/{date}", 400);
  });
});
