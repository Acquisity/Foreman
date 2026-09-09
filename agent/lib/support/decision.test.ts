import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideSupport,
  pendingFailureReport,
  type SupportObservation,
} from "./decision.js";

const row = {
  delivery_attempted: false,
  processed_version: "old",
  report: null as string | null,
  report_kind: null as "final" | "failure" | null,
  version: "old",
};
const current: SupportObservation = {
  closed: false,
  hasLinkedIssues: true,
  snoozed: false,
  version: "new",
};

test("support decision makes delivery, closure and retry precedence explicit", () => {
  assert.equal(pendingFailureReport(row), false);
  assert.equal(
    pendingFailureReport({
      ...row,
      report: "access failure",
      report_kind: "failure",
    }),
    true
  );
  assert.equal(
    pendingFailureReport({
      ...row,
      report: "final reply",
      report_kind: "final",
    }),
    false
  );
  assert.equal(
    decideSupport(
      { ...row, delivery_attempted: true, report: "old reply" },
      { ...current, closed: true }
    ).kind,
    "reconcile"
  );
  assert.equal(
    decideSupport(
      { ...row, report: "unsent reply" },
      { ...current, closed: true }
    ).kind,
    "closed"
  );
  assert.equal(
    decideSupport(
      {
        ...row,
        delivery_attempted: true,
        report: "attempted reply",
        version: current.version,
      },
      current
    ).kind,
    "reconcile"
  );
  assert.equal(
    decideSupport({ ...row, report: "reply", version: "new" }, current).kind,
    "pending-delivery"
  );
  assert.equal(
    decideSupport(
      { ...row, delivery_attempted: true, report: "old reply" },
      current
    ).kind,
    "reconcile"
  );
  assert.deepEqual(
    decideSupport({ ...row, report: "obsolete reply" }, current),
    { discardReport: true, kind: "investigate" }
  );
});

test("quiet and snoozed cases settle without losing linked engineering changes", () => {
  assert.deepEqual(decideSupport(row, { ...current, version: "old" }), {
    discardReport: false,
    kind: "unchanged",
    processed: false,
  });
  assert.deepEqual(
    decideSupport(row, { ...current, hasLinkedIssues: false, snoozed: true }),
    { discardReport: false, kind: "unchanged", processed: true }
  );
  assert.deepEqual(decideSupport(row, { ...current, snoozed: true }), {
    discardReport: false,
    kind: "investigate",
  });
});
