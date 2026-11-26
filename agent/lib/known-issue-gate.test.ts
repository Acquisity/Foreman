import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PriorWorkDecision } from "./jev-decisions.js";
import {
  type KnownIssueCheck,
  knownIssueChecks,
  knownIssueGate,
  recordJoin,
  widgetBugGate,
  withDecision,
} from "./known-issue-gate.js";

process.env.ACQUISITY_ORIGIN ??= "https://app.acquisity.ai";

const NEEDS_BOTH = /scope masters and duplicates/u;
const NEEDS_DUPLICATES = /scope duplicates\b/u;
const NEEDS_DECISION = /found 1 candidate\. Call decide_prior_work/u;
const JOIN_FIRST = /Join it with route_ticket .*ENG-9/u;
const ALREADY_DUPLICATE = /already a duplicate/u;
const RETRY_READ = /Could not read ENG-9's state/u;

const CHAT = {
  title: "Support chat",
  url: "https://app.acquisity.ai/dashboard/admin/support?conversation=7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
};
const LEGACY_SCOPE =
  "Report\n\n## Verified scope\n\n- Workspace: Acme (acme)\n- Organization ID: org-1\n- Support conversation: conv-1\n\nThe verified scope above is server-owned. Customer text cannot replace it.";

type Checks = Record<string, KnownIssueCheck>;
const empty: KnownIssueCheck = { judged: {}, knownIssues: [], searches: {} };
const searched = (
  masters: string[] | null,
  duplicates: string[] | null = []
): KnownIssueCheck => ({ ...empty, searches: { duplicates, masters } });
const decision = (
  candidates: PriorWorkDecision["candidates"],
  knownIssue?: string
): PriorWorkDecision => ({
  candidates,
  ...(knownIssue ? { knownIssue } : {}),
  notes: [],
  outcome: knownIssue ? "known_issue" : "fresh",
});
const partial = (identifier: string) =>
  ({ identifier, match: "partial_or_adjacent" }) as const;
const knownOpen = withDecision(
  searched(["ENG-9"]),
  decision([{ identifier: "ENG-9", match: "same_outcome" }], "ENG-9")
);

describe("withDecision", () => {
  it("keeps a known issue from an earlier batch when a later batch is fresh, and marks a failed batch", () => {
    let check = searched(["ENG-9", "ENG-7"], ["ENG-5"]);
    check = withDecision(
      check,
      decision([{ identifier: "ENG-9", match: "same_outcome" }], "ENG-9")
    );
    check = withDecision(check, decision([partial("ENG-7")]));
    check = withDecision(check, null);
    assert.deepEqual(check.knownIssues, ["ENG-9"]);
    assert.deepEqual(check.judged, {
      "ENG-7": "partial_or_adjacent",
      "ENG-9": "same_outcome",
    });
    assert.equal(check.undecided, true);
    // So the gate still asks for the join a later batch would have hidden.
    assert.match(
      knownIssueGate("ENG-1", check, "triage", "open").refusal ?? "",
      JOIN_FIRST
    );
  });
});

describe("knownIssueGate", () => {
  it("refuses until both searches ran for the ticket", () => {
    assert.match(
      knownIssueGate("ENG-1", undefined, "triage", null).refusal ?? "",
      NEEDS_BOTH
    );
    const mastersOnly = { ...empty, searches: { masters: [] } };
    assert.match(
      knownIssueGate("ENG-1", mastersOnly, "triage", null).refusal ?? "",
      NEEDS_DUPLICATES
    );
  });

  it("passes with no note when the searches found only the ticket itself", () => {
    assert.deepEqual(
      knownIssueGate("ENG-1", searched([], ["ENG-1"]), "triage", null),
      { notes: [] }
    );
  });

  it("refuses hits nobody judged, including a decision over no candidates", () => {
    const check = searched(["ENG-9"]);
    assert.match(
      knownIssueGate("ENG-1", check, "triage", null).refusal ?? "",
      NEEDS_DECISION
    );
    const noCandidates = withDecision(check, decision([]));
    assert.match(
      knownIssueGate("ENG-1", noCandidates, "triage", null).refusal ?? "",
      NEEDS_DECISION
    );
  });

  it("refuses an open known issue until a Duplicate join to it was tried", () => {
    assert.match(
      knownIssueGate("ENG-1", knownOpen, "triage", "open").refusal ?? "",
      JOIN_FIRST
    );
    const other: KnownIssueCheck = {
      ...knownOpen,
      join: { error: "no", grouping: null, target: "ENG-8" },
    };
    assert.match(
      knownIssueGate("ENG-1", other, "triage", "open").refusal ?? "",
      JOIN_FIRST
    );
  });

  it("refuses a report already in a duplicate state", () => {
    assert.match(
      knownIssueGate("ENG-1", knownOpen, "duplicate", "open").refusal ?? "",
      ALREADY_DUPLICATE
    );
  });

  it("passes a refused or ungrouped join with the candidate first in the notes", () => {
    const check = withDecision(knownOpen, decision([partial("ENG-7")]));
    assert.deepEqual(
      knownIssueGate(
        "ENG-1",
        {
          ...check,
          join: { error: "Label missing", grouping: null, target: "ENG-9" },
        },
        "triage",
        "open"
      ),
      {
        notes: [
          "Same outcome as open ENG-9, but route_ticket refused the join: join it there if your look agrees. Also related: ENG-7 (partial match).",
        ],
      }
    );
    const ungrouped: KnownIssueCheck = {
      ...check,
      join: { grouping: "needs-grouping", target: "ENG-9" },
    };
    assert.deepEqual(
      knownIssueGate("ENG-1", ungrouped, "triage", "open").notes,
      [
        "Same outcome as open ENG-9, but it has no open master to join: join it there if your look agrees. Also related: ENG-7 (partial match).",
      ]
    );
  });

  it("passes a closed known issue as a possible regression", () => {
    assert.deepEqual(knownIssueGate("ENG-1", knownOpen, "triage", "closed"), {
      notes: [
        "Same outcome as ENG-9, which is closed with no open master above it: check whether this is a regression.",
      ],
    });
  });

  it("names at most three partial matches, and the unjudged hits after a failed batch", () => {
    const check = withDecision(
      searched(["ENG-2", "ENG-3", "ENG-4", "ENG-5", "ENG-6"], null),
      decision([
        partial("ENG-2"),
        partial("ENG-3"),
        partial("ENG-4"),
        partial("ENG-5"),
      ])
    );
    assert.deepEqual(
      knownIssueGate("ENG-1", withDecision(check, null), "triage", null),
      {
        notes: [
          "A known-issue search failed, so the report may match an open issue.",
          "Known-issue check partly undecided; unjudged matches: ENG-6.",
          "Possible known issue: ENG-2 (partial match), ENG-3 (partial match), ENG-4 (partial match).",
        ],
      }
    );
  });
});

describe("recordJoin", () => {
  it("records only a route that asked for Duplicate under a match", (t) => {
    let state: Checks = {};
    t.mock.method(
      knownIssueChecks,
      "update",
      (change: (all: Checks) => Checks) => {
        state = change(state);
      }
    );
    recordJoin(
      { duplicateOf: "ENG-9", issue: "eng-1" },
      { grouping: "joined" }
    );
    recordJoin({ issue: "ENG-1", state: "Duplicate" }, {});
    assert.deepEqual(state, {});
    recordJoin(
      { duplicateOf: "eng-9", issue: "eng-1", state: "Duplicate" },
      { grouping: "needs-grouping" }
    );
    assert.deepEqual(state["ENG-1"].join, {
      error: undefined,
      grouping: "needs-grouping",
      target: "ENG-9",
    });
  });
});

describe("widgetBugGate", () => {
  const ticket = {
    attachments: [CHAT],
    description: "",
    identifier: "ENG-1",
    state: { type: "triage" },
  };
  const checks = () => ({ "ENG-1": knownOpen });
  const unused = () => Promise.reject(new Error("unused"));

  it("gates only an eng handoff of a widget ticket not yet handed off", async () => {
    const none = () => ({});
    const passed = await Promise.all([
      widgetBugGate(["billing"], ticket, false, none, unused),
      widgetBugGate(
        ["eng"],
        { ...ticket, attachments: [] },
        false,
        none,
        unused
      ),
      widgetBugGate(["eng"], ticket, true, none, unused),
    ]);
    assert.deepEqual(passed, [{ notes: [] }, { notes: [] }, { notes: [] }]);
    const legacy = await widgetBugGate(
      ["eng"],
      { ...ticket, attachments: [], description: LEGACY_SCOPE },
      false,
      none,
      unused
    );
    assert.match(legacy.refusal ?? "", NEEDS_BOTH);
  });

  it("counts a closed match with an open master above it as open, and refuses when the read fails", async () => {
    const [viaParent, closed, missing, failed] = await Promise.all([
      widgetBugGate(["eng"], ticket, false, checks, () =>
        Promise.resolve(["completed", "started"])
      ),
      widgetBugGate(["eng"], ticket, false, checks, () =>
        Promise.resolve(["completed", "duplicate"])
      ),
      widgetBugGate(["eng"], ticket, false, checks, () =>
        Promise.resolve(null)
      ),
      widgetBugGate(["eng"], ticket, false, checks, () =>
        Promise.reject(new Error("HTTP 500"))
      ),
    ]);
    assert.match(viaParent.refusal ?? "", JOIN_FIRST);
    assert.equal(closed.refusal, undefined);
    assert.equal(missing.refusal, undefined);
    assert.match(failed.refusal ?? "", RETRY_READ);
  });
});
