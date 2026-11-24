import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CapabilityGap,
  countedDescription,
  fileCapabilityGap,
  fileRunGaps,
  type GapFiling,
  gapDescription,
  gapsFromResult,
  generalFact,
} from "./widget-capability-gaps.js";

const KEY_LINE = /^- Gap key: orders: why a domain order/mu;
const COUNT_THREE = /^\* Conversations: 3$/mu;
const COUNT_TWO = /^- Conversations: 2$/mu;

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

test("a missing fact naming something from a workspace is refused", () => {
  for (const named of [
    "the inbox sam@example.com",
    "whether acme.io resolves",
    "see https://x.test",
    "the run 0b7c4a2e-1111-4222-8333-444455556666",
    "invoice 12345",
    'the campaign "Spring"',
  ]) {
    assert.equal(generalFact(named), null, named);
  }
  assert.equal(
    generalFact("  Why a   domain order is waiting for payment "),
    "why a domain order is waiting for payment"
  );
});

test("the count line goes up by one and nothing else changes", () => {
  const gap: CapabilityGap = {
    area: "orders",
    fact: "why a domain order is waiting for payment",
    kind: "tool",
    source: "investigator",
  };
  const first = gapDescription(gap);
  assert.match(first, KEY_LINE);
  // Linear stores "- " bullets as "* ".
  const stored = first.replaceAll("\n- ", "\n* ");
  const twice = countedDescription(countedDescription(stored));
  assert.match(twice, COUNT_THREE);
  assert.equal(twice.replace("Conversations: 3", "Conversations: 1"), stored);
});

interface Call {
  name: string;
  variables: Record<string, unknown>;
}

/** A fake Linear that holds one team, its labels, and the tickets and comments written. */
const fakeLinear = (labels = ["Capability Gap", "Docs Gap", "fixy"]) => {
  const calls: Call[] = [];
  const issues: { description: string; id: string; identifier: string }[] = [];
  const comments = new Set<string>();
  const request = <T>(
    name: string,
    _query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> => {
    calls.push({ name, variables });
    const input = variables.input as Record<string, unknown> | undefined;
    const answers: Record<string, () => unknown> = {
      CapabilityGapComment: () => {
        const id = String(input?.id);
        if (comments.has(id)) {
          // The shape eve's LinearApiError has (measured on real Linear, SAN-284).
          throw Object.assign(
            new Error(
              "Linear GraphQL CapabilityGapComment failed with HTTP 200."
            ),
            {
              body: {
                data: null,
                errors: [{ message: "conflict on insert of Comment" }],
              },
            }
          );
        }
        comments.add(id);
        return { commentCreate: { success: true } };
      },
      CapabilityGapCount: () => {
        const issue = issues.find((entry) => entry.id === variables.id);
        if (issue) {
          issue.description = String(variables.description);
        }
        return { issueUpdate: { success: true } };
      },
      CapabilityGapCreate: () => {
        const issue = {
          description: String(input?.description),
          id: `issue-${issues.length + 1}`,
          identifier: `ENG-${issues.length + 1}`,
        };
        issues.push(issue);
        return { issueCreate: { issue } };
      },
      CapabilityGapFind: () => ({
        issueLabels: {
          nodes: labels.map((label) => ({
            id: `label-${label}`,
            name: label,
            team: null,
          })),
        },
        issues: { nodes: issues.slice(0, 1) },
        teams: { nodes: [{ id: "team-eng" }] },
      }),
      CapabilityGapLabel: () => ({ issueAddLabel: { success: true } }),
    };
    return Promise.resolve(answers[name]?.() as T);
  };
  return { calls, comments, issues, request };
};

const gap: CapabilityGap = {
  area: "billing",
  fact: "the stripe section could not be read",
  kind: "tool",
  reason: "timeout",
  source: "code",
};
const { signal } = new AbortController();

test("a new gap files one ticket with its kind label, comments for the conversation, then adds fixy last", async () => {
  const linear = fakeLinear();
  const filed = await fileCapabilityGap(
    gap,
    { conversationId: "conv-1", runId: "run-1" },
    signal,
    linear.request as never
  );
  assert.deepEqual(filed, { identifier: "ENG-1", outcome: "filed" });
  assert.deepEqual(
    linear.calls.map((call) => call.name),
    [
      "CapabilityGapFind",
      "CapabilityGapCreate",
      "CapabilityGapComment",
      "CapabilityGapLabel",
    ]
  );
  const create = linear.calls[1]?.variables.input as Record<string, unknown>;
  assert.equal(
    create.title,
    "Capability gap: billing: the stripe section could not be read"
  );
  assert.deepEqual(create.labelIds, ["label-Capability Gap"]);
  assert.equal(linear.calls[3]?.variables.label, "label-fixy");
  const comment = linear.calls[2]?.variables.input as Record<string, unknown>;
  assert.equal(
    comment.body,
    "Seen in support conversation conv-1 (Foreman run run-1). Reason: timeout."
  );
});

test("a second conversation counts once on the open ticket; the same conversation again changes nothing", async () => {
  const linear = fakeLinear();
  const file = (conversationId: string, runId: string) =>
    fileCapabilityGap(
      gap,
      { conversationId, runId },
      signal,
      linear.request as never
    );
  await file("conv-1", "run-1");
  assert.deepEqual(await file("conv-2", "run-2"), {
    identifier: "ENG-1",
    outcome: "counted",
  });
  assert.deepEqual(await file("conv-2", "run-3"), {
    identifier: "ENG-1",
    outcome: "seen",
  });
  assert.equal(linear.issues.length, 1);
  assert.equal(linear.comments.size, 2);
  assert.match(linear.issues[0]?.description ?? "", COUNT_TWO);
});

test("a docs gap needs the Docs Gap label, and a missing label files nothing", async () => {
  const linear = fakeLinear(["Capability Gap", "fixy"]);
  const filed = await fileCapabilityGap(
    { ...gap, kind: "docs" },
    { conversationId: "conv-1", runId: "run-1" },
    signal,
    linear.request as never
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
