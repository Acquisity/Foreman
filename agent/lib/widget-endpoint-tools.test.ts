import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { type TestContext, test } from "node:test";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { WIDGET_ENDPOINT_MANIFEST } from "./widget-endpoint-manifest.js";
import {
  endpointManifestSchema,
  renderEndpointManifest,
} from "./widget-endpoint-schema.js";
import {
  CODE_ONLY_AREAS,
  callWidgetEndpoint,
  endpointToolCheck,
  endpointToolName,
  endpointToolNames,
  endpointToolSet,
  HELD_AREAS,
  heldAreasOfRun,
  LEGACY_TOOL_AREAS,
  legacyToolOffered,
  offeredEndpointTools,
} from "./widget-endpoint-tools.js";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import { judgeToolCapabilities } from "./widget-judge-tools.js";
import {
  stampedWidgetAttributes,
  widgetAuth,
  widgetContext,
} from "./widget-scope.js";

// Acquisity's serializeForemanManifest() output for two scratch definitions,
// measured with apps/web/scripts/print-foreman-manifest.mjs. These tests hold
// lead-pipeline themselves (FIXTURE_HELD), whatever the rollout has switched,
// so the offered ones are the scratch areas.
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
const FIXTURE_HELD: ReadonlySet<string> = new Set(["lead-pipeline"]);
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
  assert.deepEqual(offeredEndpointTools(undefined, manifest, FIXTURE_HELD), []);
  assert.deepEqual(offeredEndpointTools([], manifest, FIXTURE_HELD), []);
});

test("only listed, unheld endpoints are offered, at the highest listed version, with only the listed sections", () => {
  const offered = offeredEndpointTools(
    [
      listed("lead-pipeline", 1, ["sources"]),
      listed("scratch-area", 1, ["domains"]),
      listed("owned-identifiers", 1, []),
    ],
    manifest,
    FIXTURE_HELD
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
    manifest,
    FIXTURE_HELD
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
  const set = endpointToolSet(listedAuth, manifest, FIXTURE_HELD);
  assert.deepEqual(Object.keys(set ?? {}), ["widget_scratch_area"]);
  assert.equal(
    endpointToolSet(widgetAuth(verifiedWidgetContext), manifest, FIXTURE_HELD),
    null
  );
  assert.equal(endpointToolSet(null, manifest, FIXTURE_HELD), null);
  // Listed, but its only manifest entry at that path is a held area.
  assert.equal(
    endpointToolSet(
      widgetAuth({
        ...verifiedWidgetContext,
        endpoints: [listed("lead-pipeline", 1, ["sources"])],
      }),
      manifest,
      FIXTURE_HELD
    ),
    null
  );
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
    transformed.tools?.map((listedTool) => listedTool.name),
    ["widget_known_issues"]
  );
});

test("progress maps a generated tool by its area and ignores unknown names", () => {
  assert.equal(endpointToolCheck("widget_lead_pipeline", manifest), "leads");
  assert.equal(endpointToolCheck("widget_crm_contact"), "crm");
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
  const many = [...new Array(50).keys()].map((n) =>
    listed(
      `area-${n}`,
      1,
      [...new Array(50).keys()].map((m) => `s${m}`)
    )
  );
  assert.ok(
    String(
      widgetAuth({ ...verifiedWidgetContext, endpoints: many }).attributes
        ?.endpoints
    ).length >
      16 * 1024
  );
  assert.equal(
    widgetContext(widgetAuth({ ...verifiedWidgetContext, endpoints: many }))
      ?.endpoints?.length,
    50
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

// ENG-20528: eve names a hand-written tool by its file, so an area switched
// off HELD_AREAS while agent/tools still holds a tool of the same name would
// register two widget_<area> tools. The switch deletes or renames the old one.
const offeredClashes = (
  held: ReadonlySet<string>,
  files: readonly string[]
) => {
  const handWritten = new Set(
    files
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.slice(0, -3))
  );
  return WIDGET_ENDPOINT_MANIFEST.endpoints
    .filter(
      (entry) => !(held.has(entry.name) || CODE_ONLY_AREAS.has(entry.name))
    )
    .map((entry) => endpointToolName(entry.name))
    .filter((name) => handWritten.has(name));
};

test("no offered endpoint tool shares its name with a hand-written tool", () => {
  assert.deepEqual(
    offeredClashes(
      HELD_AREAS,
      readdirSync(new URL("../tools/", import.meta.url))
    ),
    []
  );
  // Unholding an area whose old tool file is still there is caught.
  const unheld = new Set([...HELD_AREAS].filter((area) => area !== "account"));
  assert.deepEqual(
    [...new Set(offeredClashes(unheld, ["widget_account.ts", "other.ts"]))],
    ["widget_account"]
  );
});

// ENG-20609: one switch decision. Taking an area out of HELD_AREAS offers its
// endpoint tool and takes its old tool off, with nothing else to edit.
const AREAS = [
  ...new Set(
    WIDGET_ENDPOINT_MANIFEST.endpoints
      .map(({ name }) => name)
      .filter((name) => !CODE_ONLY_AREAS.has(name))
  ),
];
const ALL_LISTED = WIDGET_ENDPOINT_MANIFEST.endpoints.map((entry) => ({
  name: entry.name,
  path: entry.path,
  sections: entry.sections.map((section) => section.name),
  version: entry.version,
}));
const HELD_STATES: [string, ReadonlySet<string>][] = [
  ["every area held", new Set(AREAS)],
  ["every area switched", new Set()],
  ["the rollout today", HELD_AREAS],
  ...AREAS.map((area): [string, ReadonlySet<string>] => [
    `only ${area} switched`,
    new Set(AREAS.filter((other) => other !== area)),
  ]),
];

test("held and legacy areas are the manifest's own areas, and every held area has an old tool", () => {
  for (const area of HELD_AREAS) {
    assert.ok(AREAS.includes(area), area);
    assert.ok(
      Object.values(LEGACY_TOOL_AREAS).some((areas) => areas.includes(area)),
      area
    );
  }
  for (const areas of Object.values(LEGACY_TOOL_AREAS)) {
    for (const area of areas) {
      assert.ok(AREAS.includes(area), area);
    }
  }
});

for (const [label, held] of HELD_STATES) {
  test(`${label}: an area offers its endpoint tool exactly when switched, and its old tools exactly while held`, () => {
    const offered = new Set(
      offeredEndpointTools(ALL_LISTED, WIDGET_ENDPOINT_MANIFEST, held).map(
        ({ name }) => name
      )
    );
    for (const area of AREAS) {
      assert.equal(offered.has(endpointToolName(area)), !held.has(area), area);
    }
    for (const [legacy, areas] of Object.entries(LEGACY_TOOL_AREAS)) {
      assert.equal(
        legacyToolOffered(legacy, held),
        areas.some((area) => held.has(area)),
        legacy
      );
    }
    // The judge sees exactly what the lane offers: no old tool past its area's
    // switch, every switched endpoint, and no name twice.
    const judged = judgeToolCapabilities(ALL_LISTED, held).map(
      ({ name }) => name
    );
    assert.equal(new Set(judged).size, judged.length);
    for (const area of AREAS) {
      const name = endpointToolName(area);
      // CRM contact's old tool shares its endpoint tool's name (ENG-20528).
      assert.equal(
        judged.includes(name),
        !held.has(area) ||
          (name in LEGACY_TOOL_AREAS && legacyToolOffered(name, held)),
        area
      );
    }
    for (const legacy of Object.keys(LEGACY_TOOL_AREAS)) {
      if (!(legacyToolOffered(legacy, held) || offered.has(legacy))) {
        assert.equal(judged.includes(legacy), false, legacy);
      }
    }
  });
}

test("job failures stays on the lane until orders, lead pipeline and AI generation have all switched", () => {
  const offered = (held: string[]) =>
    legacyToolOffered("widget_job_failures", new Set(held));
  assert.equal(offered(["orders"]), true);
  assert.equal(offered(["lead-pipeline"]), true);
  assert.equal(offered(["ai-generation"]), true);
  assert.equal(offered(["billing", "campaigns"]), false);
  // A tool that answers for no area is never an area's to take off.
  assert.equal(legacyToolOffered("widget_help_article", new Set()), true);
});

test("the judge is given only the endpoint tools the case's own endpoint list offered", () => {
  const none = new Set<string>();
  assert.deepEqual(
    judgeToolCapabilities(undefined, none).filter(({ name }) =>
      AREAS.some((area) => endpointToolName(area) === name)
    ),
    []
  );
  const orders = WIDGET_ENDPOINT_MANIFEST.endpoints.find(
    ({ name }) => name === "orders"
  );
  assert.ok(orders && orders.sections.length > 1);
  const [kept, dropped] = orders.sections;
  const judged = judgeToolCapabilities(
    [
      {
        name: "orders",
        path: orders.path,
        sections: [kept.name],
        version: orders.version,
      },
    ],
    none
  );
  const ordersTool = judged.find(({ name }) => name === "widget_orders");
  assert.ok(ordersTool);
  assert.ok(ordersTool.description.includes(`- ${kept.name}: `));
  assert.equal(ordersTool.description.includes(`- ${dropped.name}: `), false);
  assert.equal(
    judged.some(({ name }) => name === "widget_billing"),
    false
  );
});

test("an old production run is judged against its own rollout, read from the tools it called", () => {
  const today = new Set(["billing", "campaigns"]);
  // It called the old orders tool, so orders was held then; it called the
  // campaigns endpoint, so campaigns had switched.
  assert.deepEqual(
    heldAreasOfRun(
      ["widget_provisioning_status", "widget_campaigns", "widget_help_article"],
      today
    ),
    ["billing", "orders"]
  );
  // Job failures and the shared CRM name say nothing about which area was held.
  assert.deepEqual(
    heldAreasOfRun(["widget_job_failures", "widget_crm_contact"], today),
    ["billing", "campaigns"]
  );
  const judged = judgeToolCapabilities(
    ALL_LISTED,
    new Set(heldAreasOfRun(["widget_provisioning_status"], new Set()))
  ).map(({ name }) => name);
  assert.ok(judged.includes("widget_provisioning_status"));
  assert.equal(judged.includes("widget_orders"), false);
  assert.ok(judged.includes("widget_billing"));
});
