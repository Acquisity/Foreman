import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERNAL_ORGS } from "./internal-orgs.js";
import {
  type CapabilityGap,
  countedDescription,
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
      result("widget_lead_pipeline", {
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
    gapsFromResult(result("widget_website", { status: "not_linked" })),
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

test("only an endpoint body's sections are gaps; a source nested in any other answered read is not", () => {
  assert.deepEqual(
    gapsFromResult(
      result("widget_account", {
        status: "ok",
        userErrorSignals: {
          reason: "sentry_unreachable",
          status: "unavailable",
        },
      })
    ),
    []
  );
  assert.deepEqual(
    gapsFromResult(
      result("widget_billing", {
        available: true,
        unavailable: ["stripe: timeout"],
      })
    ),
    []
  );
});

test("a call the framework refused or whose input was rejected opens nothing", () => {
  assert.deepEqual(
    gapsFromResult(
      result(
        "widget_billing",
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

const NO_PLAN_CARD = /with no plan card, question card or draft/;
const DAILY_TRIAGE =
  /Fixy's daily triage judges .* and adds the `fixy` label only when there is something to build/;
const OWN_TICKET =
  /move money becomes its own ENG ticket without the `fixy` label, linked from this one/;
const WAITS_FOR_APPROVAL = /waits for approval/;

test("the description tells Fixy's reader no plan card waits and an action fix becomes its own ticket", () => {
  const text = gapDescription({
    area: "campaigns",
    fact: "why a campaign stopped sending",
    kind: "tool",
    source: "reply",
  });
  assert.match(text, NO_PLAN_CARD);
  assert.match(text, DAILY_TRIAGE);
  assert.match(text, OWN_TICKET);
  assert.doesNotMatch(text, WAITS_FOR_APPROVAL);
});

interface Call {
  name: string;
  variables: Record<string, unknown>;
}
interface FakeIssue {
  /** Days since the ticket was closed; open when unset. */
  closedDaysAgo?: number;
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
const fakeLinear = (labels = ["Capability Gap", "Docs Gap"]) => {
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
          labels: [...((input?.labelIds as string[] | undefined) ?? [])],
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
            .filter((issue) => issue.closedDaysAgo === undefined)
            .slice(0, 1)
            .map((issue) => ({
              ...issue,
              comments: { nodes: [...issue.comments] },
              labels: { nodes: issue.labels.map((id) => ({ id })) },
            })),
        },
        judged: {
          nodes: issues
            .filter(
              ({ closedDaysAgo, comments }) =>
                closedDaysAgo !== undefined &&
                closedDaysAgo <= 30 &&
                comments.some((c) => c.body.startsWith(String(variables.seen)))
            )
            .slice(0, 1)
            .map(({ identifier }) => ({ identifier })),
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
const CUSTOMER_ORG = "11111111-1111-4111-8111-111111111111";
const fileWith =
  (linear: ReturnType<typeof fakeLinear>, filed: CapabilityGap = gap) =>
  (conversationId: string, runId: string) =>
    fileCapabilityGap(
      filed,
      { conversationId, organizationId: CUSTOMER_ORG, runId },
      signal,
      linear.request as never
    );

test("a new gap files one ticket, comments for the conversation, then adds its kind label last and never fixy", async () => {
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
  assert.equal(create.labelIds, undefined);
  assert.deepEqual(linear.issues[0]?.labels, ["label-Capability Gap"]);
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

test("a first comment that failed leaves the ticket without its kind label until a retry saves it", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  linear.failing.add("WidgetTicketComment");
  await assert.rejects(file("conv-1", "run-1"));
  assert.deepEqual(linear.issues[0]?.labels, []);
  assert.deepEqual(await file("conv-1", "run-2"), {
    identifier: "ENG-1",
    outcome: "counted",
  });
  assert.equal(linear.issues.length, 1);
  assert.equal(linear.issues[0]?.comments.length, 1);
  assert.deepEqual(linear.issues[0]?.labels, ["label-Capability Gap"]);
});

test("a ticket closed more than 30 days ago no longer holds its conversations back", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  await file("conv-1", "run-1");
  const [first] = linear.issues;
  if (first) {
    first.closedDaysAgo = 31;
  }
  assert.deepEqual(await file("conv-1", "run-2"), {
    identifier: "ENG-2",
    outcome: "filed",
  });
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

test("a conversation a closed ticket already judged writes nothing; a new conversation files a new ticket", async () => {
  const linear = fakeLinear();
  const file = fileWith(linear);
  await file("conv-1", "run-1");
  const [first] = linear.issues;
  if (first) {
    first.closedDaysAgo = 1;
  }
  const calls = linear.calls.length;
  assert.deepEqual(await file("conv-1", "run-2"), {
    identifier: "ENG-1",
    outcome: "judged",
  });
  assert.deepEqual(
    linear.calls.slice(calls).map((call) => call.name),
    ["CapabilityGapFind"]
  );
  assert.deepEqual(linear.calls.at(-1)?.variables, {
    seen: "Seen in support conversation conv-1 ",
    since: "-P30D",
    team: "ENG",
    title: "Capability gap: billing: the stripe section could not be read",
  });
  assert.equal(linear.issues.length, 1);
  assert.deepEqual(await file("conv-2", "run-3"), {
    identifier: "ENG-2",
    outcome: "filed",
  });
  assert.deepEqual(
    linear.issues[1]?.comments.map((comment) => comment.body),
    [
      "Seen in support conversation conv-2 (Foreman run run-3). Reason: timeout.",
    ]
  );
  // The judged conversation stays off the new ticket too.
  assert.equal((await file("conv-1", "run-4")).outcome, "judged");
  assert.equal(linear.issues[1]?.comments.length, 1);
});

test("a docs gap needs the Docs Gap label, and a missing label files nothing", async () => {
  const linear = fakeLinear(["Capability Gap"]);
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
    { conversationId: "conv-1", organizationId: CUSTOMER_ORG, runId: "run-1" },
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

test("a run in an internal workspace files nothing and logs each gap skipped_internal", async () => {
  const lines: string[] = [];
  const { info } = console;
  console.info = (line: string) => {
    lines.push(line);
  };
  let filed = 0;
  try {
    for (const organizationId of INTERNAL_ORGS) {
      // biome-ignore lint/performance/noAwaitInLoops: one run per workspace, in order.
      await fileRunGaps(
        [gap, { ...gap, area: "orders" }],
        {
          conversationId: "conv-1",
          organizationId: organizationId.toUpperCase(),
          runId: "run-1",
        },
        signal,
        () => {
          filed += 1;
          return Promise.resolve({ identifier: "ENG-1", outcome: "filed" });
        }
      );
    }
  } finally {
    console.info = info;
  }
  assert.equal(filed, 0);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [...INTERNAL_ORGS].flatMap(() =>
      ["billing", "orders"].map((tool) => ({
        conversationId: "conv-1",
        event: "widget.capability_gap",
        outcome: "skipped_internal",
        runId: "run-1",
        tool,
      }))
    )
  );
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
    output: {
      sections: {},
      status: "ok",
      unavailable: [{ reason: "timeout", section: "invoices" }],
    },
    toolName: "widget_billing",
  });
  const website = (output: unknown, extra: object = {}) =>
    readRefusal({
      kind: "tool-result",
      output,
      toolName: "widget_website",
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
    ],
    [true, true, true, true, true, true]
  );
  // One refused section inside an answered read is not the area's refusal.
  assert.deepEqual(
    [
      website({
        sections: {},
        status: "ok",
        unavailable: [{ reason: "feature_off", section: "render" }],
      }),
    ],
    [false]
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
        fact: "the invoices section could not be read",
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

test("an area a feature that is off closes files no reply gap of either kind (ENG-20478)", () => {
  assert.deepEqual(
    replyGaps(
      [
        {
          area: "website",
          fact: "site status and publish state",
          kind: "tool",
        },
        { area: "website", fact: "how publishing works", kind: "docs" },
        { area: "inboxes", fact: "dns and live sending health", kind: "tool" },
      ],
      [],
      [],
      ["website"]
    ).map((each) => `${each.area}/${each.kind}`),
    ["inboxes/tool"]
  );
});

// ENG-20543: the old billing tool's BILLING_REFUSALS ("workspace could not be
// verified", "productDb: organization not found") kept a membership refusal from
// filing a gap. The billing endpoint answers that refusal as { status: "denied" }
// (Acquisity's foremanEndpointHandler, HTTP 401/403), which must do the same.
test("the billing endpoint's refusal files no gap and silences the reply's billing tool facts", () => {
  const denied = result("widget_billing", { status: "denied" });
  assert.deepEqual(gapsFromResult(denied), []);
  assert.deepEqual(readRefusal(denied), { area: "billing", refused: true });
  const gaps = replyGaps(
    [
      { area: "billing", fact: "whether an invoice was paid", kind: "tool" },
      { area: "billing", fact: "how credits roll over", kind: "docs" },
    ],
    [],
    ["billing"]
  );
  assert.deepEqual(
    gaps.map(({ area, source }) => ({ area, source })),
    [{ area: "billing", source: "reply" }]
  );
  assert.equal(gaps[0]?.kind, "docs");
  // A section the endpoint could not read still files, keyed as the old tool's.
  assert.deepEqual(
    gapsFromResult(
      result("widget_billing", {
        sections: {},
        status: "ok",
        unavailable: [{ reason: "timeout", section: "stripe" }],
      })
    ).map(({ area, fact }) => [area, fact]),
    [["billing", "the stripe section could not be read"]]
  );
});
