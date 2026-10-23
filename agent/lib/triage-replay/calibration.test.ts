import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrate,
  calibrated,
  documentSha256,
  handLabelsSchema,
  renderCalibration,
} from "./calibration.js";
import { makeResult } from "./fixtures.js";
import type { RootCauseGrade } from "./score.js";

const ONE_PER_ROW = /One hand label per row/;
const AGREEMENT = /Agreement with the hand labels: 75\.0% \(3\/4\)/;
const FLIPS = /Flip rate on a rerun: 33\.3% \(1\/3\)/;
const COVERAGE = /Hand labels: 4, measured 2, stale 1 .*missing 1/;
const NOT_MEASURED = /not measured \(pass --rerun\)/;

const doc = (text: string) =>
  makeResult("ENG-1", {
    document: { text, updatedAt: "2026-09-01T10:05:00.000Z" },
  });
const results = new Map([
  ["ENG-1#1", doc("Root cause: renderPanel cleared the layout.")],
  ["ENG-2#1", doc("Root cause: the token refresh.")],
  ["ENG-3#1", doc("Root cause: the import mapper.")],
  ["ENG-4#1", doc("Root cause: the sync job.")],
]);
const sha = (row: string) => documentSha256(results.get(row) ?? doc("")) ?? "";
const labels = handLabelsSchema.parse([
  {
    documentSha256: sha("ENG-1#1"),
    grade: "match",
    reason: "secret text",
    row: "ENG-1#1",
  },
  { documentSha256: sha("ENG-2#1"), grade: "wrong", row: "ENG-2#1" },
  { documentSha256: "0".repeat(64), grade: "match", row: "ENG-3#1" },
  { documentSha256: sha("ENG-4#1"), grade: "partial", row: "ENG-4#1" },
]);
const first = new Map<string, RootCauseGrade>([
  ["ENG-1#1", "match"],
  ["ENG-2#1", "wrong"],
  ["ENG-3#1", "match"],
]);
const second = new Map<string, RootCauseGrade>([
  ["ENG-1#1", "match"],
  ["ENG-2#1", "partial"],
  ["ENG-3#1", "match"],
]);

test("agreement counts only hand labels on the document the judge graded, both passes on a rerun", () => {
  const calibration = calibrate(labels, results, first, second);
  assert.deepEqual(calibration.coverage, {
    labelled: 4,
    measured: 2,
    missing: 1,
    stale: 1,
  });
  assert.deepEqual(calibration.agreement, { agree: 3, total: 4 });
  assert.deepEqual(calibration.flips, { flipped: 1, total: 3 });
  assert.equal(calibrated(calibration), false);
  const card = renderCalibration(calibration);
  assert.match(card, AGREEMENT);
  assert.match(card, FLIPS);
  assert.match(card, COVERAGE);
  assert.equal(card.includes("secret text"), false);
});

test("a single pass reports agreement without a flip rate and is never calibrated", () => {
  const measured = labels.filter(
    ({ row }) => row !== "ENG-3#1" && row !== "ENG-4#1"
  );
  const once = calibrate(measured, results, first);
  assert.equal(once.flips, null);
  assert.deepEqual(once.agreement, { agree: 2, total: 2 });
  assert.equal(calibrated(once), false);
  assert.match(renderCalibration(once), NOT_MEASURED);
  assert.equal(calibrated(calibrate(measured, results, first, first)), true);
});

test("hand labels name each row once", () => {
  assert.throws(
    () => handLabelsSchema.parse([labels[0], labels[0]]),
    ONE_PER_ROW
  );
});
