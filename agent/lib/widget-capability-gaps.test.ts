import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CapabilityGap,
  countedDescription,
  distinctGaps,
  fileCapabilityGap,
  fileRunGaps,
  type GapFiling,
  gapDescription,
  gapsFromResult,
  gapTitle,
  generalFact,
  readRefusal,
  replyGaps,
  withDetails,
} from "./widget-capability-gaps.js";

const MAILBOXES_ADDED =
  /Couldn't check: why a domain was suspended; whether its mailboxes still exist\.$/u;
const FOUND_BY_EXTRACTION = /Found by: the extraction pass/u;
const KEY_LINE = /^- Gap key: orders: why a domain order/mu;
const COUNT_THREE = /^\* Conversations: 3$/mu;
const COUNT_TWO = /^- Conversations: 2$/mu;
const COUNT_ONE = /^- Conversations: 1$/mu;

const result = (toolName: string, output: unknown, isError = false) => ({
  isError,
  kind: "tool-result",
  output,
  toolName,
});

test("an endpoint section that failed or timed out is a gap; one whose feature is off is not", () => {
  assert.deepEqual(
    gapsFromResult(
      result("widget_billing", {
        sections: {},
        status: "ok",
        unavailable: [
          { reason: "timeout", section: "stripe" },
          { reason: "feature_off", section: "deliverability" },
          { reason: "error", section: "ledger" },
        ],
      })
    ),
    [
      {
        area: "billing",
        fact: "the stripe section could not be read",
        kind: "tool",
        reason: "timeout",
        source: "code",
      },
      {
        area: "billing",
        fact: "the ledger section could not be read",
        kind: "tool",
        reason: "error",
        source: "code",
      },
    ]
  );
});

test("a whole check that was unavailable or threw is one gap, named for its area", () => {
  assert.deepEqual(
    gapsFromResult(
      result("widget_lead_pipeline_status", {
        message: "x",
        status: "unavailable",
      })
    ),
    [
      {
        area: "lead-pipeline",
        fact: "the whole check could not be read",
        kind: "tool",
        reason: "unavailable",
        source: "code",
      },
    ]
  );
  assert.equal(
    gapsFromResult(result("widget_ai_sdr", null, true))[0]?.reason,
    "error"
  );
});

test("refusals by design, non-reads and other tools open nothing", () => {
  for (const status of ["denied", "feature_off", "invalid_input", "ok"]) {
    assert.deepEqual(
      gapsFromResult(result("widget_orders", { status, unavailable: [] })),
      [],
      status
    );
  }
  assert.deepEqual(
    gapsFromResult(result("widget_website_status", { status: "not_linked" })),
    []
  );
  assert.deepEqual(
    gapsFromResult(result("widget_file_ticket", { status: "unavailable" })),
    []
  );
  assert.deepEqual(
    gapsFromResult(result("github__create_issue", { status: "unavailable" })),
    []
  );
  assert.deepEqual(gapsFromResult({ kind: "subagent-result" }), []);
});

test("what report_capability_gap recorded is a gap from the investigator; a refused call is not", () => {
  assert.deepEqual(
    gapsFromResult(
      result("report_capability_gap", {
        gap: {
          area: "orders",
          fact: "why a domain order is waiting for payment",
          kind: "tool",
        },
        recorded: true,
      })
    ),
    [
      {
        area: "orders",
        fact: "why a domain order is waiting for payment",
        kind: "tool",
        source: "investigator",
      },
    ]
  );
  assert.deepEqual(
    gapsFromResult(
      result("report_capability_gap", { error: "x", recorded: false })
    ),
    []
  );
});

test("the hand-written tools' own failure shapes are gaps, by source", () => {
  // widget_billing_summary: string entries naming the source first.
  assert.deepEqual(
    gapsFromResult(
      result("widget_billing_summary", {
        available: true,
        unavailable: [
          "stripe: timeout",
          "productDb.creditHistory read unavailable",
        ],
      })
    ).map((found) => [found.area, found.fact]),
    [
      ["billing", "the stripe section could not be read"],
      ["billing", "the productDb.creditHistory section could not be read"],
    ]
  );
  // widget_account_access and widget_generation_diagnostics nest a failed source in an ok result.
  assert.deepEqual(
    gapsFromResult(
      result("widget_account_access", {
        status: "ok",
        userErrorSignals: {
          reason: "sentry_unreachable",
          status: "unavailable",
        },
      })
    ),
    [
      {
        area: "account",
        fact: "the userErrorSignals section could not be read",
        kind: "tool",
        reason: "sentry_unreachable",
        source: "code",
      },
    ]
  );
  assert.deepEqual(
    gapsFromResult(
      result("widget_generation_diagnostics", {
        signals: {
          axiom: {
            items: [],
            reason: "provider_failure",
            status: "unavailable",
          },
          sentry: { items: [], status: "ok" },
        },
        status: "ok",
      })
    ).map((found) => found.fact),
    ["the signals.axiom section could not be read"]
  );
  // Website status reads its sources per project; two projects' renders are one gap.
  assert.deepEqual(
    distinctGaps(
      gapsFromResult(
        result("widget_website_status", {
          projects: [
            {
              id: "p1",
              live: { status: "live" },
              publicCheck: {
                dns: { A: { status: "unavailable" }, NS: { status: "ok" } },
                http: { status: "ok" },
              },
              render: { status: "unavailable" },
            },
            {
              id: "p2",
              live: { status: "unavailable" },
              render: { status: "unavailable" },
            },
          ],
          status: "ok",
        })
      )
    ).map((found) => [found.area, found.fact]),
    [
      ["website", "the projects.publicCheck.dns.A section could not be read"],
      ["website", "the projects.render section could not be read"],
      ["website", "the projects.live section could not be read"],
    ]
  );
  // Billing read nothing by design: the membership check refused.
  assert.deepEqual(
    gapsFromResult(
      result("widget_billing_summary", {
        available: false,
        unavailable: ["workspace could not be verified"],
      })
    ),
    []
  );
  // A list's entries are records, and a record's name is never a source.
  assert.deepEqual(
    gapsFromResult(
      result("widget_inbox_health", {
        accounts: [{ status: "unavailable" }],
        byName: { "Spring Launch": { status: "unavailable" } },
        status: "ok",
      })
    ),
    []
  );
});

test("a call the framework refused or whose input was rejected opens nothing", () => {
  assert.deepEqual(
    gapsFromResult(
      result(
        "widget_billing_summary",
        {
          code: "TOOL_EXECUTION_DENIED",
          message: "Support widget investigations only.",
        },
        true
      )
    ),
    []
  );
  assert.deepEqual(
    gapsFromResult({
      ...result("widget_orders", "Invalid input for tool widget_orders", true),
      errorName: "AI_InvalidToolInputError",
    }),
    []
  );
  assert.equal(
    gapsFromResult({
      ...result("widget_orders", "fetch failed", true),
      errorName: "TypeError",
    }).length,
    1
  );
});

test("a missing fact naming something from a workspace is refused", () => {
  for (const named of [
    "the inbox sam@example.com",
    "whether acme.io resolves",
    "see https://x.test",
    "the run 0b7c4a2e-1111-4222-8333-444455556666",
    "invoice 12345",
    'the campaign "Spring"',
    "why Acme Corp's order waits",
    "whether Sam Lee was invited",
  ]) {
    assert.equal(generalFact(named), null, named);
  }
  assert.equal(
    generalFact("  Why a   domain order is waiting for payment "),
    "why a domain order is waiting for payment"
  );
  // An acronym keeps its case: "dNS status" made a broken gap title.
  assert.equal(
    generalFact("DNS status of a sending domain"),
    "DNS status of a sending domain"
  );
});

test("the count line takes the given count and nothing else changes", () => {
  const investigated: CapabilityGap = {
    area: "orders",
    fact: "why a domain order is waiting for payment",
    kind: "tool",
    source: "investigator",
  };
  const first = gapDescription(investigated);
  assert.match(first, KEY_LINE);
  // Linear stores "- " bullets as "* ".
  const stored = first.replaceAll("\n- ", "\n* ");
  const counted = countedDescription(stored, 3);
  assert.match(counted, COUNT_THREE);
  assert.equal(counted.replace("Conversations: 3", "Conversations: 1"), stored);
});

interface Call {
  name: string;
  variables: Record<string, unknown>;
}
interface FakeIssue {
  closed?: boolean;
  comments: { body: string; id: string }[];
  description: string;
  id: string;
  identifier: string;
  labels: string[];
}

// The shape eve's LinearApiError has (measured on real Linear, SAN-284).
const taken = () =>
  Object.assign(
    new Error("Linear GraphQL WidgetTicketComment failed with HTTP 200."),
    {
      body: {
        data: null,
        errors: [{ message: "conflict on insert of Comment" }],
      },
    }
  );

/**
 * A fake Linear holding one team, its labels, and the tickets and comments
 * written. A call named in `failing` throws once, after nothing was written.
 */
const fakeLinear = (labels = ["Capability Gap", "Docs Gap", "fixy"]) => {
  const calls: Call[] = [];
  const issues: FakeIssue[] = [];
  const failing = new Set<string>();
  const issueOf = (id: unknown) => issues.find((entry) => entry.id === id);
  const request = <T>(
    name: string,
    _query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> => {
    calls.push({ name, variables });
    if (failing.delete(name)) {
      return Promise.reject(new Error(`${name} timed out`));
    }
    const input = variables.input as Record<string, unknown> | undefined;
    const answers: Record<string, () => unknown> = {
      CapabilityGapCount: () => {
        const issue = issueOf(variables.id);
        if (issue) {
          issue.description = String(variables.description);
        }
        return { issueUpdate: { success: true } };
      },
      CapabilityGapCreate: () => {
        const issue: FakeIssue = {
          comments: [],
          description: String(input?.description),
          id: `issue-${issues.length + 1}`,
          identifier: `ENG-${issues.length + 1}`,
          labels: [...(input as { labelIds: string[] }).labelIds],
        };
        issues.push(issue);
        return { issueCreate: { issue } };
      },
      CapabilityGapDetails: () => {
        for (const issue of issues) {
          const comment = issue.comments.find((c) => c.id === variables.id);
          if (comment) {
            comment.body = String(variables.body);
          }
        }
        return { commentUpdate: { success: true } };
      },
      CapabilityGapFind: () => ({
        issueLabels: {
          nodes: labels.map((label) => ({ id: `label-${label}`, name: label })),
        },
        issues: {
          nodes: issues
            .filter((issue) => !issue.closed)
            .slice(0, 1)
            .map((issue) => ({
              ...issue,
              comments: { nodes: [...issue.comments] },
              labels: { nodes: issue.labels.map((id) => ({ id })) },
            })),
        },
        teams: { nodes: [{ id: "team-eng" }] },
      }),
      CapabilityGapLabel: () => {
        issueOf(variables.id)?.labels.push(String(variables.label));
        return { issueAddLabel: { success: true } };
      },
      WidgetTicketComment: () => {
        const issue = issueOf(input?.issueId);
        const id = String(input?.id);
        if (
          !issue ||
          issues.some((entry) => entry.comments.some((c) => c.id === id))
        ) {
          throw taken();
        }
        issue.comments.push({ body: String(input?.body), id });
        return { commentCreate: { success: true } };
      },
    };
    return Promise.resolve(answers[name]?.() as T);
  };
  return { calls, failing, issues, request };
};

const gap: CapabilityGap = {
  area: "billing",
  fact: "the stripe section could not be read",
  kind: "tool",
  reason: "timeout",
  source: "code",
};
const { signal } = new AbortController();
const fileWith =
  (linear: ReturnType<typeof fakeLinear>, filed: CapabilityGap = gap) =>
  (conversationId: string, runId: string) =>
    fileCapabilityGap(
      filed,
      { conversationId, runId },
      signal,
      linear.request as never
    );

test("a new gap files one ticket with its kind label, comments for the conversation, then adds fixy last", async () => {
  const linear = fakeLinear();
  assert.deepEqual(await fileWith(linear)("conv-1", "run-1"), {
    identifier: "ENG-1",
    outcome: "filed",
  });
  assert.deepEqual(
    linear.calls.map((call) => call.name),
    [
      "CapabilityGapFind",
      "CapabilityGapCreate",
      "WidgetTicketComment",
      "CapabilityGapLabel",
    ]
  );
  const create = linear.calls[1]?.variables.input as Record<string, unknown>;
  assert.equal(
    create.title,
    "Capability gap: billing: the stripe section could not be read"
  );
  assert.deepEqual(create.labelIds, ["label-Capability Gap"]);
  assert.deepEqual(linear.issues[0]?.labels, [
    "label-Capability Gap",
    "label-fixy",
  ]);
  assert.equal(
    linear.issues[0]?.comments[0]?.body,
    "Seen in support conversation conv-1 (Foreman run run-1). Reason: timeout."
  );
});

test("a second conversation counts once on the open ticket; the same conversation again changes nothing", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  await file("conv-1", "run-1");
  assert.deepEqual(await file("conv-2", "run-2"), {
    identifier: "ENG-1",
    outcome: "counted",
  });
  const writes = linear.calls.length;
  assert.deepEqual(await file("conv-2", "run-3"), {
    identifier: "ENG-1",
    outcome: "seen",
  });
  // Only the find and the refused comment: the count and labels already hold.
  assert.equal(linear.calls.length - writes, 2);
  assert.equal(linear.issues.length, 1);
  assert.equal(linear.issues[0]?.comments.length, 2);
  assert.match(linear.issues[0]?.description ?? "", COUNT_TWO);
});

test("a fixy label that failed to land is added by the next call", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  linear.failing.add("CapabilityGapLabel");
  await assert.rejects(file("conv-1", "run-1"));
  assert.deepEqual(linear.issues[0]?.labels, ["label-Capability Gap"]);
  assert.deepEqual(await file("conv-1", "run-2"), {
    identifier: "ENG-1",
    outcome: "seen",
  });
  assert.deepEqual(linear.issues[0]?.labels, [
    "label-Capability Gap",
    "label-fixy",
  ]);
});

test("a count that failed to update is set from the comments on the next call", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  await file("conv-1", "run-1");
  linear.failing.add("CapabilityGapCount");
  await assert.rejects(file("conv-2", "run-2"));
  assert.match(linear.issues[0]?.description ?? "", COUNT_ONE);
  assert.deepEqual(await file("conv-2", "run-3"), {
    identifier: "ENG-1",
    outcome: "seen",
  });
  assert.match(linear.issues[0]?.description ?? "", COUNT_TWO);
});

test("a gap whose ticket was closed gets a new ticket", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  await file("conv-1", "run-1");
  const [first] = linear.issues;
  if (first) {
    first.closed = true;
  }
  assert.deepEqual(await file("conv-1", "run-2"), {
    identifier: "ENG-2",
    outcome: "filed",
  });
  assert.equal(linear.issues[1]?.comments.length, 1);
});

test("with no fixy label in Linear, an open ticket is reported failed, not counted", async () => {
  const linear = fakeLinear();
  await fileWith(linear)("conv-1", "run-1");
  const without = fakeLinear(["Capability Gap", "Docs Gap"]);
  without.issues.push(...linear.issues);
  const filed = await fileWith(without)("conv-2", "run-2");
  assert.equal(filed.outcome, "failed");
});

test("a docs gap needs the Docs Gap label, and a missing label files nothing", async () => {
  const linear = fakeLinear(["Capability Gap", "fixy"]);
  const filed = await fileWith(linear, { ...gap, kind: "docs" })(
    "conv-1",
    "run-1"
  );
  assert.equal(filed.outcome, "failed");
  assert.deepEqual(
    linear.calls.map((call) => call.name),
    ["CapabilityGapFind"]
  );
});

test("a run files each gap key once, and a failure never throws", async () => {
  const seen: string[] = [];
  const reasons: (string | undefined)[] = [];
  await fileRunGaps(
    [gap, { ...gap, reason: "error" }, { ...gap, fact: "another fact" }],
    { conversationId: "conv-1", runId: "run-1" },
    signal,
    (filed): Promise<GapFiling> => {
      seen.push(filed.fact);
      reasons.push(filed.reason);
      return filed.fact === "another fact"
        ? Promise.reject(new Error("Linear down"))
        : Promise.resolve({ identifier: "ENG-1", outcome: "filed" });
    }
  );
  assert.deepEqual(reasons, ["timeout", "timeout"]);
  assert.deepEqual(seen, [
    "the stripe section could not be read",
    "another fact",
  ]);
});

test("what a reply couldn't check is one gap per area and kind, never a ticket per wording (ENG-20478)", () => {
  const gaps = replyGaps([
    { area: "orders", fact: "why a domain was suspended", kind: "tool" },
    { area: "orders", fact: "The reason a domain is suspended", kind: "tool" },
    { area: "orders", fact: "why a domain was suspended", kind: "tool" },
    { area: "orders", fact: "what suspended means", kind: "docs" },
    { area: "inboxes", fact: "why lee@acme.com bounced", kind: "tool" },
  ]);
  assert.deepEqual(
    gaps.map((each) => [gapTitle(each), each.details]),
    [
      [
        "Capability gap: orders: something a reply said could not be checked",
        ["why a domain was suspended", "the reason a domain is suspended"],
      ],
      [
        "Docs gap: orders: a product question a reply said the Help Centre does not answer",
        ["what suspended means"],
      ],
      [
        "Capability gap: inboxes: something a reply said could not be checked",
        ["one item that named workspace data, left out"],
      ],
    ]
  );
  assert.match(gapDescription(gaps[0]), FOUND_BY_EXTRACTION);
});

test("a failed read carries the reply's tool facts, a refused read files only its docs facts", () => {
  const failed = gapsFromResult({
    kind: "tool-result",
    output: { available: true, unavailable: ["stripe: timeout"] },
    toolName: "widget_billing_summary",
  });
  const website = (output: unknown, extra: object = {}) =>
    readRefusal({
      kind: "tool-result",
      output,
      toolName: "widget_website_status",
      ...extra,
    })?.refused;
  // A whole check refused by design, the same refusals gapsFromResult knows.
  assert.deepEqual(
    [
      website({ status: "denied" }),
      website({ status: "invalid_input" }),
      website({ status: "feature_off" }),
      website({ status: "not_linked" }),
      website({ code: "TOOL_EXECUTION_DENIED" }, { isError: true }),
      website(null, { errorName: "AI_InvalidToolInputError", isError: true }),
      readRefusal({
        kind: "tool-result",
        output: { unavailable: ["workspace could not be verified"] },
        toolName: "widget_billing_summary",
      })?.refused,
    ],
    [true, true, true, true, true, true, true]
  );
  // One refused section or project inside an answered read is not the area's refusal.
  assert.deepEqual(
    [
      website({
        sections: {},
        status: "ok",
        unavailable: [{ reason: "feature_off", section: "render" }],
      }),
      website({ projects: [{ render: { status: "not_linked" } }] }),
    ],
    [false, false]
  );
  assert.deepEqual(
    readRefusal({
      kind: "tool-result",
      output: { status: "ok" },
      toolName: "widget_inboxes",
    }),
    { area: "inboxes", refused: false }
  );
  const gaps = replyGaps(
    [
      { area: "billing", fact: "whether an invoice was paid", kind: "tool" },
      { area: "billing", fact: "how credits roll over", kind: "docs" },
      { area: "website", fact: "whether the site is live", kind: "tool" },
      { area: "website", fact: "what a not linked site means", kind: "docs" },
    ],
    failed,
    ["website"]
  );
  assert.deepEqual(
    gaps.map(({ area, details, fact, source }) => ({
      area,
      details,
      fact,
      source,
    })),
    [
      {
        area: "billing",
        details: ["whether an invoice was paid"],
        fact: "the stripe section could not be read",
        source: "code",
      },
      {
        area: "billing",
        details: ["how credits roll over"],
        fact: "a product question a reply said the Help Centre does not answer",
        source: "reply",
      },
      {
        area: "website",
        details: ["what a not linked site means"],
        fact: "a product question a reply said the Help Centre does not answer",
        source: "reply",
      },
    ]
  );
});

test("a later run adds its facts to the conversation's one comment", async () => {
  const linear = fakeLinear();
  const [first] = replyGaps([
    { area: "orders", fact: "why a domain was suspended", kind: "tool" },
  ]);
  const [second] = replyGaps([
    { area: "orders", fact: "why a domain was suspended", kind: "tool" },
    { area: "orders", fact: "whether its mailboxes still exist", kind: "tool" },
  ]);
  await fileWith(linear, first)("conv-1", "run-1");
  assert.equal(
    (await fileWith(linear, second)("conv-1", "run-2")).outcome,
    "seen"
  );
  assert.equal(
    withDetails(linear.issues[0].comments[0].body, second.details),
    null
  );
  assert.match(linear.issues[0].comments[0].body, MAILBOXES_ADDED);
  // Nothing new: no write.
  const calls = linear.calls.length;
  await fileWith(linear, second)("conv-1", "run-3");
  assert.equal(
    linear.calls
      .slice(calls)
      .some(({ name }) => name === "CapabilityGapDetails"),
    false
  );
});

test("each conversation's comment lists what its reply couldn't check", async () => {
  const [replied] = replyGaps([
    { area: "orders", fact: "why a domain was suspended", kind: "tool" },
  ]);
  const linear = fakeLinear();
  assert.equal(
    (await fileWith(linear, replied)("conv-1", "run-1")).outcome,
    "filed"
  );
  assert.deepEqual(
    linear.issues[0].comments.map((comment) => comment.body),
    [
      "Seen in support conversation conv-1 (Foreman run run-1). Couldn't check: why a domain was suspended.",
    ]
  );
});

test("a fact with the comment's separator in it stays one fact, and jobs is an area", () => {
  const [jobsGap] = replyGaps([
    {
      area: "jobs",
      fact: "why a scrape failed; and when it retries",
      kind: "tool",
    },
  ]);
  assert.equal(
    gapTitle(jobsGap),
    "Capability gap: jobs: something a reply said could not be checked"
  );
  assert.deepEqual(jobsGap.details, [
    "why a scrape failed, and when it retries",
  ]);
  const body = "Seen in support conversation c (Foreman run r).";
  const once = withDetails(body, jobsGap.details) ?? "";
  assert.equal(withDetails(once, jobsGap.details), null);
});
