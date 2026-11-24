import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { type GateDeps, gate } from "./widget-egress.js";
import {
  buildMembershipQuery,
  resolveOwnedIdentifiers,
  WorkspaceAccessDenied,
} from "./widget-evidence.js";

const SECRET = "s".repeat(32);
const campaignId = "44444444-4444-4444-8444-444444444444";
const foreignId = "55555555-5555-4555-8555-555555555555";
const NOT_CONFIGURED = /not configured/;
const INVALID = /Invalid identifier candidate/;

const none = { emails: [], slugs: [], uuids: [] };
const owned = (sets: Partial<Record<string, string[]>> = {}) => ({
  endpoint: "owned-identifiers",
  sections: {
    owned: { domains: [], emails: [], slugs: [], uuids: [], ...sets },
  },
  status: "ok",
  unavailable: [],
  version: 1,
});

function withEnv(t: { after: (fn: () => void) => void }) {
  const before = {
    ACQUISITY_ORIGIN: process.env.ACQUISITY_ORIGIN,
    FOREMAN_DIAGNOSTICS_SECRET: process.env.FOREMAN_DIAGNOSTICS_SECRET,
  };
  process.env.ACQUISITY_ORIGIN = "https://app.test";
  process.env.FOREMAN_DIAGNOSTICS_SECRET = SECRET;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

const answering = (status: number, body: unknown) => {
  const sent: { body: Record<string, unknown>; init: RequestInit }[] = [];
  const request = ((url, init) => {
    assert.equal(
      url,
      "https://app.test/api/internal/foreman/owned-identifiers"
    );
    sent.push({ body: JSON.parse(String(init?.body)), init: init ?? {} });
    return Promise.resolve(Response.json(body, { status }));
  }) as typeof fetch;
  return { request, sent };
};

const resolve = (
  request: typeof fetch,
  candidates: Parameters<typeof resolveOwnedIdentifiers>[1] = none
) =>
  resolveOwnedIdentifiers(
    scope,
    candidates,
    AbortSignal.timeout(5000),
    request
  );

test("the owner check asks Acquisity's endpoint with the verified ids and lowercased candidates, never SQL", async (t) => {
  withEnv(t);
  const { request, sent } = answering(
    200,
    owned({
      domains: ["acme.com"],
      emails: ["sam@acme.com"],
      slugs: [scope.organizationSlug.toLowerCase()],
      uuids: [campaignId.toUpperCase()],
    })
  );
  const result = await resolve(request, {
    domains: ["Acme.com", "other.com"],
    emails: ["Sam@Acme.com", "lee@other.com"],
    slugs: [scope.organizationSlug],
    uuids: [campaignId, foreignId],
  });
  assert.equal(sent.length, 1);
  const [{ body, init }] = sent;
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(
    new Headers(init.headers).get("authorization"),
    `Bearer ${SECRET}`
  );
  assert.deepEqual(body, {
    conversationId: scope.conversationId,
    domains: ["acme.com", "other.com"],
    emails: ["sam@acme.com", "lee@other.com"],
    organizationId: scope.organizationId,
    slugs: [scope.organizationSlug.toLowerCase()],
    userId: scope.userId,
    uuids: [campaignId, foreignId],
  });
  // Only what the endpoint returned is owned; the rest stays foreign.
  assert.deepEqual([...result.uuids], [campaignId]);
  assert.deepEqual([...result.emails], ["sam@acme.com"]);
  assert.deepEqual([...result.domains], ["acme.com"]);
  assert.deepEqual([...result.slugs], [scope.organizationSlug.toLowerCase()]);
});

test("a denied answer (not an owner or admin, or not this user's chat) is WorkspaceAccessDenied", async (t) => {
  withEnv(t);
  const { request } = answering(403, { status: "denied" });
  await assert.rejects(resolve(request), WorkspaceAccessDenied);
});

test("any other failure throws without meaning denied or nothing owned", async (t) => {
  withEnv(t);
  const failures: [number, unknown][] = [
    [401, { status: "denied" }],
    [503, { status: "unavailable" }],
    [400, { status: "invalid_input" }],
    [500, {}],
    [403, { features: ["x"], status: "feature_off" }],
    // The owned section itself could not be read.
    [
      200,
      {
        sections: {},
        status: "ok",
        unavailable: [{ reason: "timeout", section: "owned" }],
      },
    ],
    [200, { status: "ok" }],
  ];
  for (const [status, body] of failures) {
    // biome-ignore lint/performance/noAwaitInLoops: each answer is its own case.
    await assert.rejects(resolve(answering(status, body).request), (error) => {
      assert.ok(!(error instanceof WorkspaceAccessDenied), `${status}`);
      return true;
    });
  }
  await assert.rejects(
    resolve(() => Promise.reject(new TypeError("fetch failed"))),
    (error) => !(error instanceof WorkspaceAccessDenied)
  );
});

test("an unconfigured secret refuses before any request", async (t) => {
  withEnv(t);
  process.env.FOREMAN_DIAGNOSTICS_SECRET = "";
  const { request, sent } = answering(200, owned());
  await assert.rejects(resolve(request), NOT_CONFIGURED);
  assert.equal(sent.length, 0);
});

test("an invalid or oversized candidate list refuses before any request", async (t) => {
  withEnv(t);
  const { request, sent } = answering(200, owned());
  for (const candidates of [
    { emails: ["x'); drop table member; --@a.b"], slugs: [], uuids: [] },
    { emails: [], slugs: [], uuids: ["not-a-uuid"] },
    { domains: ["a.com'); --"], emails: [], slugs: [], uuids: [] },
    {
      emails: [],
      slugs: [],
      uuids: Array.from(
        { length: 101 },
        (_, n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`
      ),
    },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each list is its own case.
    await assert.rejects(resolve(request, candidates), INVALID);
  }
  assert.equal(sent.length, 0);
});

test("the bug report's membership check is one fixed query, any role, on the verified ids only", () => {
  const query = buildMembershipQuery(scope);
  assert.match(query, new RegExp(`o\\.id = '${scope.organizationId}'::uuid`));
  assert.match(query, new RegExp(`m\\.user_id = '${scope.userId}'::uuid`));
  assert.ok(query.includes("o.deleted_at is null and m.deleted_at is null"));
  assert.ok(query.includes(`o.partner_id = '${scope.partnerId}'::uuid`));
  assert.ok(!query.includes("m.role"));
  assert.throws(() =>
    buildMembershipQuery({ ...scope, userId: "x'); drop table member; --" })
  );
});

test("an email or domain longer than the endpoint accepts is not sent, so it stays foreign", async (t) => {
  withEnv(t);
  const { request, sent } = answering(200, owned());
  const long = `${"a".repeat(316)}@b.co`;
  const longDomain = `${"a".repeat(250)}.com`;
  const result = await resolve(request, {
    domains: [longDomain, "acme.com"],
    emails: [long, "sam@acme.com"],
    slugs: [],
    uuids: [],
  });
  assert.deepEqual(sent[0].body.emails, ["sam@acme.com"]);
  assert.deepEqual(sent[0].body.domains, ["acme.com"]);
  assert.equal(result.emails.has(long), false);
});
test("an id the endpoint does not return as owned never reaches the reply", async (t) => {
  withEnv(t);
  const { request } = answering(200, owned({ uuids: [campaignId] }));
  const deps: GateDeps = {
    compose: () => Promise.resolve("Your campaign paused."),
    judge: () => Promise.resolve({ decision: "allow", reason: "in scope" }),
    resolve: (s, candidates, signal) =>
      resolveOwnedIdentifiers(s, candidates, signal, request),
  };
  const fact = (id: string) => ({
    claim: `Campaign ${id} paused.`,
    entityIds: [id],
    evidence: { ref: "campaigns:status", tool: "widget_campaigns" },
  });
  const findings = {
    confidence: "medium" as const,
    facts: [fact(campaignId), fact(foreignId)],
    needsHuman: false,
    recommendation: "Resume the campaign.",
    report: "The campaign paused.",
  };
  const trimmed = await gate(
    scope,
    "Why did my campaign stop?",
    findings,
    deps
  );
  assert.equal(trimmed.decision, "allow");
  assert.equal(JSON.stringify(trimmed.findings).includes(foreignId), false);
  assert.equal(trimmed.findings.facts.length, 1);

  const blocked = await gate(
    scope,
    "Why did my campaign stop?",
    {
      ...findings,
      facts: [fact(foreignId)],
      recommendation: `Resume campaign ${foreignId}.`,
    },
    deps
  );
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.reason, `foreign_identifier:${foreignId}`);
});
