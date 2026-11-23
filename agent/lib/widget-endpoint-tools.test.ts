import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { WIDGET_ENDPOINT_MANIFEST } from "./widget-endpoint-manifest.js";
import {
  endpointManifestSchema,
  renderEndpointManifest,
} from "./widget-endpoint-schema.js";
import {
  callWidgetEndpoint,
  endpointToolCheck,
  endpointToolNames,
  endpointToolSet,
  offeredEndpointTools,
} from "./widget-endpoint-tools.js";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import {
  stampedWidgetAttributes,
  widgetAuth,
  widgetContext,
} from "./widget-scope.js";

// Acquisity's serializeForemanManifest() output for two scratch definitions,
// measured with apps/web/scripts/print-foreman-manifest.mjs (lead-pipeline is
// held in Foreman, so the offered ones are the scratch areas).
const inputs = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    campaignId: { format: "uuid", type: "string" },
    sinceDays: { default: 30, maximum: 90, type: "integer" },
  },
  type: "object",
};
const manifest = endpointManifestSchema.parse({
  endpoints: [
    {
      description: "Lead scrapes and pushes",
      inputs,
      name: "lead-pipeline",
      path: "/api/internal/foreman/lead-pipeline",
      requires: ["lead_scrape"],
      sections: [{ meaning: "M", name: "sources", requires: [], statuses: {} }],
      version: 1,
    },
    {
      description: "Scratch v1",
      inputs,
      name: "scratch-area",
      path: "/api/internal/foreman/scratch-area",
      requires: [],
      sections: [
        {
          meaning: "Managed domains",
          name: "domains",
          requires: [],
          statuses: { status: ["pending", "active"] },
        },
        {
          meaning: "Flagged",
          name: "myDay",
          requires: ["my_day"],
          statuses: {},
        },
      ],
      version: 1,
    },
    {
      description: "Scratch v2",
      futureField: "kept",
      inputs,
      name: "scratch-area",
      path: "/api/internal/foreman/scratch-area/v2",
      requires: [],
      sections: [
        {
          meaning: "Managed domains",
          name: "domains",
          requires: [],
          statuses: { status: ["pending", "active"] },
        },
        { meaning: "Flagged", name: "myDay", requires: [], statuses: {} },
      ],
      version: 2,
    },
    {
      description: "Which identifiers the workspace owns",
      inputs,
      name: "owned-identifiers",
      path: "/api/internal/foreman/owned-identifiers",
      requires: [],
      sections: [],
      version: 1,
    },
  ],
  formatVersion: 1,
});
const listed = (name: string, version: number, sections: string[]) => ({
  name,
  path: `/api/internal/foreman/${name}${version > 1 ? `/v${version}` : ""}`,
  sections,
  version,
});

test("the committed manifest is a valid generated manifest", () => {
  endpointManifestSchema.parse(WIDGET_ENDPOINT_MANIFEST);
});

test("a session with no endpoint list is offered no endpoint tools", () => {
  assert.deepEqual(offeredEndpointTools(undefined, manifest), []);
  assert.deepEqual(offeredEndpointTools([], manifest), []);
});

test("only listed, unheld endpoints are offered, at the highest listed version, with only the listed sections", () => {
  const offered = offeredEndpointTools(
    [
      listed("lead-pipeline", 1, ["sources"]),
      listed("scratch-area", 1, ["domains"]),
      listed("owned-identifiers", 1, []),
    ],
    manifest
  );
  assert.deepEqual(
    offered.map(({ name, path, version }) => ({ name, path, version })),
    [
      {
        name: "widget_scratch_area",
        path: "/api/internal/foreman/scratch-area",
        version: 1,
      },
    ]
  );
  assert.ok(
    offered[0].description.startsWith(
      "Scratch v1\nSections:\n- domains: Managed domains (status: pending, active)\n"
    )
  );
  assert.equal(offered[0].description.includes("myDay"), false);
  assert.equal("$schema" in offered[0].inputSchema, false);
  assert.deepEqual(offered[0].inputSchema.properties, inputs.properties);

  const both = offeredEndpointTools(
    [
      listed("scratch-area", 2, ["domains", "myDay"]),
      listed("scratch-area", 1, ["domains"]),
    ],
    manifest
  );
  assert.deepEqual(
    both.map(({ path }) => path),
    ["/api/internal/foreman/scratch-area/v2"]
  );
  assert.ok(both[0].description.includes("\n- myDay: Flagged\n"));
});

test("a listed endpoint whose path differs from the manifest's is not offered", () => {
  assert.deepEqual(
    offeredEndpointTools(
      [{ ...listed("scratch-area", 1, []), path: "/api/internal/other" }],
      manifest
    ),
    []
  );
});

test("a session gets one tool per offered endpoint, and none outside the widget or without a list", () => {
  const listedAuth = widgetAuth({
    ...verifiedWidgetContext,
    endpoints: [listed("scratch-area", 2, ["domains"])],
  });
  const set = endpointToolSet(listedAuth, manifest);
  assert.deepEqual(Object.keys(set ?? {}), ["widget_scratch_area"]);
  assert.equal(
    endpointToolSet(widgetAuth(verifiedWidgetContext), manifest),
    null
  );
  assert.equal(endpointToolSet(null, manifest), null);
  assert.equal(endpointToolSet(listedAuth), null);
});

test("the lane admits every manifest tool name but no code-only one", () => {
  assert.deepEqual([...endpointToolNames(manifest)].sort(), [
    "widget_lead_pipeline",
    "widget_scratch_area",
  ]);
});

test("a widget_ name the committed manifest does not produce is still dropped and refused", async () => {
  const transformed = (await widgetInvestigationMiddleware().transformParams?.({
    params: {
      prompt: [],
      tools: [
        {
          inputSchema: { type: "object" },
          name: "widget_scratch_area",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "widget_known_issues",
          type: "function",
        },
      ],
    },
    type: "generate",
  } as never)) as { tools?: { name: string }[] };
  assert.deepEqual(
    transformed.tools?.map((tool) => tool.name),
    ["widget_known_issues"]
  );
});

test("progress maps a generated tool by its area and ignores unknown names", () => {
  assert.equal(endpointToolCheck("widget_lead_pipeline", manifest), "leads");
  assert.equal(endpointToolCheck("widget_scratch_area", manifest), undefined);
  assert.equal(endpointToolCheck("widget_unknown", manifest), undefined);
});

test("the manifest refuses a new format, a path that does not match, and a duplicate endpoint", () => {
  const [, one] = manifest.endpoints;
  for (const bad of [
    { endpoints: [], formatVersion: 2 },
    { endpoints: [{ ...one, path: "/elsewhere" }], formatVersion: 1 },
    { endpoints: [one, one], formatVersion: 1 },
  ]) {
    assert.equal(endpointManifestSchema.safeParse(bad).success, false);
  }
});

test("rendering keeps fields Acquisity adds and leaves the file alone when only the commit changed", () => {
  const json = JSON.stringify(manifest);
  const first = renderEndpointManifest(json, "a".repeat(40), "", (s) => s);
  assert.equal(first.changed, true);
  assert.ok(first.source.includes(`from Acquisity ${"a".repeat(40)}.`));
  assert.ok(first.source.includes('"futureField":"kept"'));
  const again = renderEndpointManifest(
    json,
    "b".repeat(40),
    first.source,
    (s) => s
  );
  assert.deepEqual(again, { changed: false, source: first.source });
  const moved = renderEndpointManifest(
    JSON.stringify({ ...manifest, endpoints: manifest.endpoints.slice(1) }),
    "b".repeat(40),
    first.source,
    (s) => s
  );
  assert.equal(moved.changed, true);
});

test("the endpoint list survives the session stamp, which holds strings only", () => {
  const endpoints = [listed("scratch-area", 1, ["domains"])];
  const auth = widgetAuth({ ...verifiedWidgetContext, endpoints });
  assert.equal(typeof auth.attributes?.endpoints, "string");
  assert.deepEqual(widgetContext(auth)?.endpoints, endpoints);
  // scripts/widget-run-stream.ts reads run stamps with the same schema.
  assert.deepEqual(
    stampedWidgetAttributes.parse(auth.attributes).endpoints,
    endpoints
  );
  assert.equal(
    widgetContext(widgetAuth(verifiedWidgetContext))?.endpoints,
    undefined
  );
});

function configure(context: TestContext) {
  for (const [name, value] of [
    ["ACQUISITY_ORIGIN", "https://pr-1-acquisity.vercel.app"],
    ["FOREMAN_DIAGNOSTICS_SECRET", "s".repeat(40)],
  ] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    context.after(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
  }
}

const toolCtx = () => ({
  abortSignal: new AbortController().signal,
  session: { auth: { initiator: widgetAuth(verifiedWidgetContext) } },
});
const tool = {
  name: "widget_scratch_area",
  path: "/api/internal/foreman/scratch-area",
};

test("a call posts the input with the verified chat's ids and returns the body as it came, unknown status and fields included", async (context) => {
  configure(context);
  const requests: { init?: RequestInit; url: string }[] = [];
  const body = {
    brandNewField: { nested: true },
    sections: { domains: [{ status: "parked_forever" }] },
    status: "ok",
    unavailable: [{ reason: "timeout", section: "myDay" }],
  };
  const result = await callWidgetEndpoint(
    toolCtx(),
    tool,
    { sinceDays: 7 },
    (url, init) => {
      requests.push({ init, url: String(url) });
      return Promise.resolve(Response.json(body));
    }
  );
  assert.deepEqual(result, body);
  assert.equal(
    requests[0].url,
    "https://pr-1-acquisity.vercel.app/api/internal/foreman/scratch-area"
  );
  assert.equal(
    new Headers(requests[0].init?.headers).get("authorization"),
    `Bearer ${"s".repeat(40)}`
  );
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    conversationId: verifiedWidgetContext.conversationId,
    organizationId: verifiedWidgetContext.organizationId,
    sinceDays: 7,
    userId: verifiedWidgetContext.userId,
  });
});

test("refusals come back as results, and anything else as unavailable", async (context) => {
  configure(context);
  const answer = (response: Response) =>
    callWidgetEndpoint(toolCtx(), tool, {}, () => Promise.resolve(response));
  assert.deepEqual(
    await answer(
      Response.json(
        { features: ["lead_scrape"], status: "feature_off" },
        { status: 403 }
      )
    ),
    { features: ["lead_scrape"], status: "feature_off" }
  );
  assert.deepEqual(
    await answer(Response.json({ status: "invalid_input" }, { status: 400 })),
    { status: "invalid_input" }
  );
  assert.deepEqual(
    await answer(Response.json({ status: "denied" }, { status: 401 })),
    { status: "denied" }
  );
  const failed = await Promise.all(
    [
      new Response("<html>", { status: 500 }),
      new Response("not json", { status: 200 }),
      Response.json({ sections: {} }),
      new Response("x".repeat(129 * 1024), { status: 200 }),
    ].map(answer)
  );
  assert.deepEqual(
    failed.map((result) => result.status),
    ["unavailable", "unavailable", "unavailable", "unavailable"]
  );
});

test("a call without the shared secret reads nothing", async (context) => {
  configure(context);
  process.env.FOREMAN_DIAGNOSTICS_SECRET = "short";
  let called = false;
  const result = await callWidgetEndpoint(toolCtx(), tool, {}, () => {
    called = true;
    return Promise.resolve(Response.json({ status: "ok" }));
  });
  assert.equal(called, false);
  assert.equal(result.status, "unavailable");
});
