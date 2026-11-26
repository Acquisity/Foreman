import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PriorWorkDecision } from "./jev-decisions.js";
import {
  type KnownIssueCheck,
  knownIssueChecks,
  knownIssueGate,
  recordJoin,
  recordKnownIssueCheck,
  recordSearch,
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
const NEEDS_TWO_DECISIONS = /found 2 candidates\. Call decide_prior_work/u;
const BOTH_FAILED = /Both known-issue searches failed/u;

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
      knownIssueGate("ENG-1", check, "triage", { "ENG-9": "open" }).refusal ??
        "",
      JOIN_FIRST
    );
  });
});

describe("knownIssueGate", () => {
  it("refuses until both searches ran for the ticket", () => {
    assert.match(
      knownIssueGate("ENG-1", undefined, "triage", {}).refusal ?? "",
      NEEDS_BOTH
    );
    const mastersOnly = { ...empty, searches: { masters: [] } };
    assert.match(
      knownIssueGate("ENG-1", mastersOnly, "triage", {}).refusal ?? "",
      NEEDS_DUPLICATES
    );
  });

  it("passes with no note when the searches found only the ticket itself", () => {
    assert.deepEqual(
      knownIssueGate("ENG-1", searched([], ["ENG-1"]), "triage", {}),
      { notes: [] }
    );
  });

  it("refuses hits nobody judged, including a decision over no candidates", () => {
    const check = searched(["ENG-9"]);
    assert.match(
      knownIssueGate("ENG-1", check, "triage", {}).refusal ?? "",
      NEEDS_DECISION
    );
    const noCandidates = withDecision(check, decision([]));
    assert.match(
      knownIssueGate("ENG-1", noCandidates, "triage", {}).refusal ?? "",
      NEEDS_DECISION
    );
  });

  it("refuses an open known issue until a Duplicate join to it was tried", () => {
    assert.match(
      knownIssueGate("ENG-1", knownOpen, "triage", { "ENG-9": "open" })
        .refusal ?? "",
      JOIN_FIRST
    );
    const other: KnownIssueCheck = {
      ...knownOpen,
      joins: { "ENG-8": { error: "no", grouping: null } },
    };
    assert.match(
      knownIssueGate("ENG-1", other, "triage", { "ENG-9": "open" }).refusal ??
        "",
      JOIN_FIRST
    );
  });

  it("refuses a report already in a duplicate state", () => {
    assert.match(
      knownIssueGate("ENG-1", knownOpen, "duplicate", { "ENG-9": "open" })
        .refusal ?? "",
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
          joins: { "ENG-9": { error: "Label missing", grouping: null } },
        },
        "triage",
        { "ENG-9": "open" }
      ),
      {
        notes: [
          "Same outcome as open ENG-9, but route_ticket refused the join: join it there if your look agrees. Also related: ENG-7 (partial match).",
        ],
      }
    );
    const ungrouped: KnownIssueCheck = {
      ...check,
      joins: { "ENG-9": { grouping: "needs-grouping" } },
    };
    assert.deepEqual(
      knownIssueGate("ENG-1", ungrouped, "triage", { "ENG-9": "open" }).notes,
      [
        "Same outcome as open ENG-9, but it has no open master to join: join it there if your look agrees. Also related: ENG-7 (partial match).",
      ]
    );
  });

  it("passes a closed known issue as a possible regression", () => {
    assert.deepEqual(
      knownIssueGate("ENG-1", knownOpen, "triage", { "ENG-9": "closed" }),
      {
        notes: [
          "Same outcome as ENG-9, which is closed with no open master above it: check whether this is a regression.",
        ],
      }
    );
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
      knownIssueGate("ENG-1", withDecision(check, null), "triage", {}),
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

describe("the recorded sequence", () => {
  it("passes only after searches, a decision on a hit, and a Duplicate join to the open known issue", async (t) => {
    let state: Checks = {};
    t.mock.method(
      knownIssueChecks,
      "update",
      (change: (all: Checks) => Checks) => {
        state = change(state);
      }
    );
    const gate = () =>
      widgetBugGate(
        ["eng"],
        {
          attachments: [CHAT],
          description: "",
          identifier: "ENG-1",
          state: { type: "triage" },
        },
        false,
        () => state,
        () => Promise.resolve(["started"])
      );
    recordSearch("eng-1", "masters", ["eng-9"]);
    recordSearch("eng-1", "duplicates", ["ENG-1", "ENG-7"]);
    // A judgment of an issue the searches never found does not count.
    recordKnownIssueCheck("eng-1", (check) =>
      withDecision(
        check,
        decision([{ identifier: "ENG-4", match: "not_relevant" }])
      )
    );
    assert.match((await gate()).refusal ?? "", NEEDS_TWO_DECISIONS);
    recordKnownIssueCheck("eng-1", (check) =>
      withDecision(
        check,
        decision([{ identifier: "ENG-9", match: "same_outcome" }], "ENG-9")
      )
    );
    assert.match((await gate()).refusal ?? "", JOIN_FIRST);
    recordJoin(
      { duplicateOf: "ENG-9", issue: "ENG-1", state: "Duplicate" },
      { error: "Label missing" }
    );
    assert.deepEqual((await gate()).notes, [
      "Same outcome as open ENG-9, but route_ticket refused the join: join it there if your look agrees.",
    ]);
  });

  it("refuses when both searches failed, and follows the open known issue over a closed one named first", async () => {
    assert.match(
      knownIssueGate("ENG-1", searched(null, null), "triage", {}).refusal ?? "",
      BOTH_FAILED
    );
    let check = searched(["ENG-8", "ENG-9"]);
    check = withDecision(
      check,
      decision([{ identifier: "ENG-8", match: "same_outcome" }], "ENG-8")
    );
    check = withDecision(
      check,
      decision([{ identifier: "ENG-9", match: "same_outcome" }], "ENG-9")
    );
    const gate = await widgetBugGate(
      ["eng"],
      {
        attachments: [CHAT],
        description: "",
        identifier: "ENG-1",
        state: { type: "triage" },
      },
      false,
      () => ({ "ENG-1": check }),
      (id) => Promise.resolve(id === "ENG-8" ? ["completed"] : ["started"])
    );
    assert.match(gate.refusal ?? "", JOIN_FIRST);
  });
});

describe("round 3 cases", () => {
  it("treats every same-outcome candidate as a known issue and needs a join to each open one", () => {
    const check = withDecision(
      searched(["ENG-8", "ENG-9"]),
      decision(
        [
          { identifier: "ENG-8", match: "same_outcome" },
          { identifier: "ENG-9", match: "same_outcome" },
        ],
        "ENG-8"
      )
    );
    assert.deepEqual(check.knownIssues, ["ENG-8", "ENG-9"]);
    const states = { "ENG-8": "closed", "ENG-9": "open" } as const;
    assert.match(
      knownIssueGate("ENG-1", check, "triage", states).refusal ?? "",
      JOIN_FIRST
    );
    const twoOpen = { "ENG-8": "open", "ENG-9": "open" } as const;
    const firstRefused: KnownIssueCheck = {
      ...check,
      joins: { "ENG-8": { error: "refused", grouping: null } },
    };
    assert.match(
      knownIssueGate("ENG-1", firstRefused, "triage", twoOpen).refusal ?? "",
      JOIN_FIRST
    );
  });

  it("keeps earlier hits when a narrowed search finds fewer, and a failure after a success keeps the success", (t) => {
    let state: Checks = {};
    t.mock.method(
      knownIssueChecks,
      "update",
      (change: (all: Checks) => Checks) => {
        state = change(state);
      }
    );
    recordSearch("ENG-1", "masters", ["ENG-9"]);
    recordSearch("ENG-1", "masters", ["ENG-1"]);
    recordSearch("ENG-1", "masters", null);
    recordSearch("ENG-1", "duplicates", null);
    assert.deepEqual(state["ENG-1"].searches, {
      duplicates: null,
      masters: ["ENG-9", "ENG-1"],
    });
  });

  it("names a failed batch's unjudged hits beside a closed known issue", () => {
    const check = withDecision(
      withDecision(
        searched(["ENG-9", "ENG-6"]),
        decision([{ identifier: "ENG-9", match: "same_outcome" }], "ENG-9")
      ),
      null
    );
    assert.deepEqual(
      knownIssueGate("ENG-1", check, "triage", { "ENG-9": "closed" }).notes,
      [
        "Same outcome as ENG-9, which is closed with no open master above it: check whether this is a regression.",
        "Known-issue check partly undecided; unjudged matches: ENG-6.",
      ]
    );
  });
});

describe("a retried batch", () => {
  it("adds no undecided note once every hit is judged", () => {
    const check = withDecision(
      withDecision(searched(["ENG-9"]), null),
      decision([{ identifier: "ENG-9", match: "not_relevant" }])
    );
    assert.deepEqual(knownIssueGate("ENG-1", check, "triage", {}), {
      notes: [],
    });
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
    assert.deepEqual(state["ENG-1"].joins, {
      "ENG-9": { error: undefined, grouping: "needs-grouping" },
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
