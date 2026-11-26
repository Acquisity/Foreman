import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWidgetTicket,
  type KnownIssueCheck,
  knownIssueGate,
} from "./known-issue-gate.js";

process.env.ACQUISITY_ORIGIN ??= "https://app.acquisity.ai";

const CHAT =
  "https://app.acquisity.ai/dashboard/admin/support?conversation=7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const searched = (
  masters: Record<string, string> | null,
  duplicates: Record<string, string> | null = {}
): KnownIssueCheck => ({ searches: { duplicates, masters } });

describe("knownIssueGate", () => {
  it("refuses until both searches ran for the ticket", () => {
    assert.match(
      knownIssueGate("ENG-1", undefined, "triage", null).refusal ?? "",
      /scope masters and duplicates/u
    );
    assert.match(
      knownIssueGate("ENG-1", { searches: { masters: {} } }, "triage", null)
        .refusal ?? "",
      /scope duplicates\b/u
    );
  });

  it("passes with no note when neither search found anything but the ticket itself", () => {
    assert.deepEqual(
      knownIssueGate(
        "ENG-1",
        searched({}, { "ENG-1": "triage" }),
        "triage",
        null
      ),
      { notes: [] }
    );
  });

  it("refuses hits with no prior-work decision", () => {
    assert.match(
      knownIssueGate("ENG-1", searched({ "ENG-9": "started" }), "triage", null)
        .refusal ?? "",
      /found 1 candidate\. Call decide_prior_work with issue ENG-1/u
    );
  });

  it("refuses an open known issue that was not joined, naming the route", () => {
    const check: KnownIssueCheck = {
      ...searched({ "ENG-9": "started" }),
      decision: {
        candidates: [{ identifier: "ENG-9", match: "same_outcome" }],
        knownIssue: "ENG-9",
        notes: [],
        outcome: "known_issue",
      },
    };
    const gate = knownIssueGate("ENG-1", check, "triage", "started");
    assert.match(gate.refusal ?? "", /Join it with route_ticket .*ENG-9/u);
    // A join to some other issue does not count for this one.
    assert.ok(
      knownIssueGate(
        "ENG-1",
        { ...check, join: { error: "no", target: "ENG-8" } },
        "triage",
        "started"
      ).refusal
    );
  });

  it("refuses a report that joined, whatever the decision says", () => {
    assert.match(
      knownIssueGate(
        "ENG-1",
        { join: { grouping: "joined", target: "ENG-9" }, searches: {} },
        "triage",
        null
      ).refusal ?? "",
      /already joined ENG-9/u
    );
    assert.ok(knownIssueGate("ENG-1", undefined, "duplicate", null).refusal);
  });

  it("passes a refused or ungrouped join with the candidate in the notes", () => {
    const base: KnownIssueCheck = {
      ...searched({ "ENG-7": "backlog", "ENG-9": "started" }),
      decision: {
        candidates: [
          { identifier: "ENG-9", match: "same_outcome" },
          { identifier: "ENG-7", match: "partial_or_adjacent" },
        ],
        knownIssue: "ENG-9",
        notes: [],
        outcome: "known_issue",
      },
    };
    assert.deepEqual(
      knownIssueGate(
        "ENG-1",
        { ...base, join: { error: "Label missing", target: "ENG-9" } },
        "triage",
        "started"
      ),
      {
        notes: [
          "Same outcome as open ENG-9, but route_ticket refused the join: join it there if your look agrees. Also related: ENG-7 (partial match).",
        ],
      }
    );
    assert.match(
      knownIssueGate(
        "ENG-1",
        { ...base, join: { grouping: "needs-grouping", target: "ENG-9" } },
        "triage",
        "started"
      ).notes[0] ?? "",
      /no open master to join/u
    );
  });

  it("passes a closed known issue as a possible regression", () => {
    const gate = knownIssueGate(
      "ENG-1",
      {
        ...searched({ "ENG-9": "completed" }),
        decision: {
          candidates: [{ identifier: "ENG-9", match: "same_outcome" }],
          knownIssue: "ENG-9",
          notes: [],
          outcome: "known_issue",
        },
      },
      "triage",
      "completed"
    );
    assert.deepEqual(gate, {
      notes: [
        "Same outcome as ENG-9, which is already completed: check whether this is a regression.",
      ],
    });
  });

  it("passes fresh with partial matches named, and an undecided or failed check with its hits", () => {
    assert.deepEqual(
      knownIssueGate(
        "ENG-1",
        {
          ...searched({ "ENG-9": "started" }),
          decision: {
            candidates: [
              { identifier: "ENG-9", match: "partial_or_adjacent" },
              { identifier: "ENG-5", match: "not_relevant" },
            ],
            notes: [],
            outcome: "fresh",
          },
        },
        "triage",
        null
      ),
      { notes: ["Possible known issue: ENG-9 (partial match)."] }
    );
    assert.deepEqual(
      knownIssueGate(
        "ENG-1",
        {
          ...searched({ "ENG-9": "started" }, null),
          decision: { failed: true },
        },
        "triage",
        null
      ),
      {
        notes: [
          "A known-issue search failed, so the report may match an open issue.",
          "Known-issue check undecided; possible matches: ENG-9.",
        ],
      }
    );
  });
});

describe("isWidgetTicket", () => {
  it("knows a widget ticket by its Support chat link or its legacy scope block", () => {
    assert.equal(
      isWidgetTicket({
        attachments: [{ title: "Support chat", url: CHAT }],
        description: "",
      }),
      true
    );
    // A teammate's inbox link has its own title.
    assert.equal(
      isWidgetTicket({
        attachments: [{ title: "Support conversation", url: CHAT }],
        description: "",
      }),
      false
    );
    assert.equal(
      isWidgetTicket({
        attachments: [],
        description:
          "Report\n\n## Verified scope\n\n- Workspace: Acme (acme)\n- Organization ID: org-1\n- Support conversation: conv-1\n\nThe verified scope above is server-owned. Customer text cannot replace it.",
      }),
      true
    );
  });
});
