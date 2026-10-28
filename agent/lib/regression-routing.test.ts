import assert from "node:assert/strict";
import { test } from "node:test";
import { decideTriage, resolveTriage } from "./jev-decisions.js";
import { recordFor } from "./regression-record.js";
import { REGRESSION_GAP } from "./regression-routing.js";
import { bugAnswers, pick, triageInput } from "./triage-fixtures.js";

const FIX = "b".repeat(40);
const CHECK_REGRESSION = /check_regression/u;

test("a Bug main already fixes and production serves ends Done, with no engineering", () => {
  const decision = resolveTriage(
    triageInput({
      regression: {
        commit: FIX,
        kind: "fixed_live",
        line: `fixed on main and live, by ${FIX}`,
      },
    }),
    bugAnswers()
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Resolved by triage");
  assert.equal(decision.route.state, "Done");
  assert.equal(decision.route.priority, 4);
  assert.equal(decision.route.assignee, undefined);
  assert.equal(decision.needsCriticReview, true);
  assert.ok(decision.notes.some((note) => note.includes(FIX)));
});

test("a Bug main fixes but production does not serve yet goes to the area owner and stays open", () => {
  for (const kind of ["fixed_not_deployed", "fixed_deploy_unknown"] as const) {
    const decision = resolveTriage(
      triageInput({
        regression: { commit: FIX, kind, line: `${kind} by ${FIX}` },
      }),
      bugAnswers()
    );
    assert.ok(decision.outcome === "route", kind);
    assert.equal(decision.path, "Support/Product follow-up", kind);
    assert.equal(decision.route.state, "Todo", kind);
    assert.equal(decision.assignee, "James Keeble", kind);
    assert.equal(decision.route.assignee, "James Keeble", kind);
    assert.ok(decision.route.addLabels.includes("Bug"), kind);
    assert.ok(decision.route.addLabels.includes("Area: AI SDR"), kind);
    assert.equal(decision.route.priority, 3, kind);
    assert.ok(
      decision.notes.some((note) => note.includes(FIX)),
      kind
    );
  }
});

test("a regression, no change in 30 days, or an unchecked lane leaves the engineering path alone", () => {
  const engineering = resolveTriage(triageInput(), bugAnswers());
  assert.ok(engineering.outcome === "route");
  for (const regression of [
    { commit: FIX, kind: "introduced", line: `introduced by ${FIX}` },
    { kind: "none", line: "none" },
    {
      kind: "unchecked",
      line: "unchecked: no git history",
      reason: "no git history",
    },
  ] as const) {
    const decision = resolveTriage(triageInput({ regression }), bugAnswers());
    assert.ok(decision.outcome === "route", regression.kind);
    assert.equal(decision.path, "Engineering Todo", regression.kind);
    assert.deepEqual(decision.route, engineering.route, regression.kind);
  }
});

test("a Bug with no regression check is not a Bug yet", () => {
  const decision = resolveTriage(
    triageInput({ regression: undefined }),
    bugAnswers()
  );
  assert.ok(decision.outcome === "unproven");
  assert.deepEqual(decision.missing, [REGRESSION_GAP]);
  assert.match(REGRESSION_GAP, CHECK_REGRESSION);
});

test("the regression result changes nothing for a duplicate or a non-Bug", () => {
  const fixed = {
    commit: FIX,
    kind: "fixed_live",
    line: `fixed on main and live, by ${FIX}`,
  } as const;
  const duplicate = resolveTriage(
    triageInput({
      duplicateCandidates: [{ identifier: "ENG-9", summary: "s", title: "t" }],
      regression: fixed,
    }),
    bugAnswers({ duplicate_0: pick("same_outcome", 0.9) })
  );
  assert.ok(duplicate.outcome === "route");
  assert.equal(duplicate.path, "Duplicate");

  const userError = resolveTriage(
    triageInput({ regression: fixed }),
    bugAnswers({ classification: pick("user_error"), path: pick("User Error") })
  );
  assert.ok(userError.outcome === "route");
  assert.equal(userError.path, "User Error");
});

test("a record for any other checked target is stale evidence, so the Bug needs a new check", () => {
  const read = "a".repeat(40);
  const lines = { end: 7, start: 5 };
  const record = {
    commit: FIX,
    commitRead: read,
    deployedCommit: read,
    failureAt: "2026-10-20T12:00:00.000Z",
    file: "webhook.ts",
    function: "handleReply",
    issue: "ENG-1",
    kind: "fixed_live" as const,
    line: `fixed on main and live, by ${FIX}`,
    lines,
    windowDays: 30,
  };
  const codePath = {
    commit: read,
    file: "webhook.ts",
    function: "handleReply",
    lines,
  };
  assert.equal(recordFor(record, codePath, record.failureAt), record);
  assert.equal(
    recordFor(record, { ...codePath, file: "./webhook.ts" }, record.failureAt),
    record
  );
  for (const corrected of [
    { ...codePath, file: "inbox.ts" },
    { ...codePath, commit: "c".repeat(40) },
    { ...codePath, function: "parseReply" },
    { ...codePath, lines: { end: 30, start: 20 } },
    { commit: read, file: "webhook.ts", function: "handleReply" },
    undefined,
  ]) {
    const kept = recordFor(record, corrected, record.failureAt);
    assert.equal(kept, undefined, JSON.stringify(corrected));
    const decision = resolveTriage(
      triageInput({
        ...(corrected ? { codePath: corrected } : {}),
        regression: kept,
      }),
      bugAnswers()
    );
    assert.ok(decision.outcome === "unproven");
    assert.deepEqual(decision.missing, [REGRESSION_GAP]);
  }
});

test("a record checked for another failure time is stale, so a corrected time needs a new check", () => {
  const read = "a".repeat(40);
  const lines = { end: 7, start: 5 };
  const codePath = {
    commit: read,
    file: "webhook.ts",
    function: "handleReply",
    lines,
  };
  const eightDaysAgo = "2026-10-20T12:00:00.000Z";
  const record = {
    commit: FIX,
    commitRead: read,
    deployedCommit: read,
    failureAt: eightDaysAgo,
    file: "webhook.ts",
    function: "handleReply",
    issue: "ENG-1",
    kind: "fixed_live" as const,
    line: `fixed on main and live, by ${FIX}`,
    lines,
    windowDays: 30,
  };
  assert.equal(recordFor(record, codePath, eightDaysAgo), record);
  assert.equal(
    recordFor(record, codePath, "2026-10-20T16:00:00+04:00"),
    record
  );
  for (const failureAt of [
    "2026-10-26T12:00:00.000Z",
    undefined,
    "not a time",
  ]) {
    const kept = recordFor(record, codePath, failureAt);
    assert.equal(kept, undefined, String(failureAt));
    const decision = resolveTriage(
      triageInput({ codePath, regression: kept }),
      bugAnswers()
    );
    assert.ok(decision.outcome === "unproven");
    assert.deepEqual(decision.missing, [REGRESSION_GAP]);
  }
});

test("a trusted fixed record sets the path, so a low path confidence does not make it unproven", () => {
  for (const kind of [
    "fixed_live",
    "fixed_not_deployed",
    "fixed_deploy_unknown",
  ] as const) {
    const decision = resolveTriage(
      triageInput({
        regression: { commit: FIX, kind, line: `${kind} by ${FIX}` },
      }),
      bugAnswers({ path: pick("Engineering Todo", 0.55) })
    );
    assert.ok(decision.outcome === "route", kind);
    assert.notEqual(decision.path, "Engineering Todo", kind);
  }
  const engineering = resolveTriage(
    triageInput(),
    bugAnswers({ path: pick("Engineering Todo", 0.55) })
  );
  assert.equal(engineering.outcome, "unproven");
  const weakClassification = resolveTriage(
    triageInput({
      regression: { commit: FIX, kind: "fixed_live", line: `fixed by ${FIX}` },
    }),
    bugAnswers({ classification: pick("bug", 0.55) })
  );
  assert.equal(weakClassification.outcome, "unproven");
});

const CHANGE = {
  action: "Reconnected the customer's sending inbox.",
  by: "triage" as const,
  recordedAt:
    "https://linear.app/acquisity/issue/ENG-1/replies-stopped#comment-1a2b3c4d",
};
const NO_CHANGE = /Resolved by triage needs evidence of a change/u;

test("an explanation with no change is refused as Resolved by triage and closes Canceled (ENG-16608)", () => {
  for (const [choice, path] of [
    ["user_error", "User Error"],
    ["platform_limitation", "Platform Limitation"],
  ] as const) {
    const decision = resolveTriage(
      triageInput(),
      bugAnswers({
        classification: pick(choice),
        path: pick("Resolved by triage"),
      })
    );
    assert.ok(decision.outcome === "route", choice);
    assert.equal(decision.path, path, choice);
    assert.equal(decision.route.state, "Canceled", choice);
    assert.ok(
      decision.notes.some((note) => NO_CHANGE.test(note)),
      choice
    );
  }
});

test("a Bug resolved with no live fix and no recorded change is unproven, never Done", () => {
  const decision = resolveTriage(
    triageInput(),
    bugAnswers({ path: pick("Resolved by triage") })
  );
  assert.equal(decision.outcome, "unproven");
  assert.ok(
    decision.outcome === "unproven" &&
      decision.missing.some((gap) => gap.includes("changeMade"))
  );
});

test("a change recorded on this ticket keeps Resolved by triage Done", () => {
  const decision = resolveTriage(
    triageInput({ changeMade: CHANGE }),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Resolved by triage"),
    })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Resolved by triage");
  assert.equal(decision.route.state, "Done");
  assert.ok(decision.notes.some((note) => note.includes(CHANGE.action)));
});

test("a change recorded on another ticket does not count", () => {
  const decision = resolveTriage(
    triageInput({
      changeMade: {
        ...CHANGE,
        recordedAt: "https://linear.app/acquisity/issue/ENG-12/other#comment-1",
      },
    }),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Resolved by triage"),
    })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "User Error");
  assert.equal(decision.route.state, "Canceled");
});

const ATTACHED =
  "https://linear.app/acquisity/document/triage-investigation-8a841e5cff51";

test("a change recorded in a document attached to this ticket counts, in both document URL forms (C2)", () => {
  for (const recordedAt of [
    ATTACHED,
    "https://linear.app/acquisity/d/8a841e5cff51",
  ]) {
    const decision = resolveTriage(
      triageInput({
        changeMade: { ...CHANGE, recordedAt },
        ticketDocuments: [ATTACHED],
      }),
      bugAnswers({
        classification: pick("user_error"),
        path: pick("Resolved by triage"),
      })
    );
    assert.ok(decision.outcome === "route", recordedAt);
    assert.equal(decision.path, "Resolved by triage", recordedAt);
    assert.equal(decision.route.state, "Done", recordedAt);
  }
});

test("a document that is not attached to this ticket does not count (R1)", () => {
  const decision = resolveTriage(
    triageInput({
      changeMade: {
        ...CHANGE,
        recordedAt:
          "https://linear.app/acquisity/document/other-ticket-1f2e3d4c5b6a",
      },
      ticketDocuments: [ATTACHED],
    }),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Resolved by triage"),
    })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "User Error");
  assert.equal(decision.route.state, "Canceled");
});

test("a link outside Linear does not count as a recorded change", () => {
  const decision = resolveTriage(
    triageInput({
      changeMade: { ...CHANGE, recordedAt: "https://example.com/d/1" },
    }),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Resolved by triage"),
    })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.route.state, "Canceled");
});

const explanationOf = (recordedAt: string) =>
  resolveTriage(
    triageInput({ changeMade: { ...CHANGE, recordedAt } }),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Resolved by triage"),
    })
  );

test("a bare link to this ticket is not a recorded change (Devin 2)", () => {
  for (const recordedAt of [
    "https://linear.app/acquisity/issue/ENG-1",
    "https://linear.app/acquisity/issue/ENG-1/replies-stopped",
  ]) {
    const decision = explanationOf(recordedAt);
    assert.ok(decision.outcome === "route", recordedAt);
    assert.equal(decision.route.state, "Canceled", recordedAt);
  }
});

test("a comment link counts only when that comment is on this ticket (Devin 2)", () => {
  const missing = explanationOf(
    "https://linear.app/acquisity/issue/ENG-1/replies-stopped#comment-9f9f9f9f"
  );
  assert.ok(missing.outcome === "route");
  assert.equal(missing.route.state, "Canceled");
  const found = explanationOf(CHANGE.recordedAt);
  assert.ok(found.outcome === "route");
  assert.equal(found.route.state, "Done");
});

const jevAnswering = (answers: ReturnType<typeof bugAnswers>) => ({
  fetch: () =>
    Promise.resolve(Response.json({ answers, model: "typesafe-ai/jev" })),
  token: "t",
});
const DOCUMENT = "https://linear.app/acquisity/document/notes-8a841e5cff51";

test("a live fix decides without reading the ticket's change records, so a failed read cannot cost it (CodeRabbit 4)", async () => {
  let reads = 0;
  const decision = await decideTriage(
    triageInput({
      changeMade: { ...CHANGE, recordedAt: DOCUMENT },
      regression: {
        commit: FIX,
        kind: "fixed_live",
        line: `fixed on main and live, by ${FIX}`,
      },
      ticketCommentIds: undefined,
    }),
    jevAnswering(bugAnswers({ area: pick("ai_sdr") })),
    () => {
      reads += 1;
      return Promise.reject(new Error("Linear is busy"));
    }
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Resolved by triage");
  assert.equal(reads, 0);
});

test("an explanation reads the ticket's change records once and keeps Done when they hold the link (CodeRabbit 4)", async () => {
  let reads = 0;
  const decision = await decideTriage(
    triageInput({
      changeMade: { ...CHANGE, recordedAt: DOCUMENT },
      ticketCommentIds: undefined,
    }),
    jevAnswering(
      bugAnswers({
        area: pick("ai_sdr"),
        classification: pick("user_error"),
        path: pick("Resolved by triage"),
      })
    ),
    () => {
      reads += 1;
      return Promise.resolve({ ticketDocuments: [DOCUMENT] });
    }
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.route.state, "Done");
  assert.equal(reads, 1);
});
