import assert from "node:assert/strict";
import { test } from "node:test";
import { withClaudeSlot } from "../claude-headless.js";
import { makeLabel, makeResult } from "./fixtures.js";
import {
  JUDGE_TIMEOUT_MS,
  parseRootCauseVerdict,
  ROOT_CAUSE_PROMPT,
  type RootCauseRunner,
  rootCauseJudge,
  rootCausePrompt,
} from "./judge.js";

const NO_ROOT_CAUSE = /no labelled root cause/;
const CAP = /cap of 2 call\(s\) exceeded at ENG-3/;
const BAD_CAP = /whole number/;

const label = makeLabel("ENG-1");
const result = makeResult("ENG-1");

test("the prompt carries the label's root cause, files and functions against the run's document and decision", () => {
  const input = JSON.parse(rootCausePrompt(label, result));
  assert.deepEqual(input, {
    label: {
      files: ["src/panel.ts"],
      functions: ["renderPanel"],
      text: label.rootCause?.text,
    },
    run: { document: "Root cause: renderPanel.", final: result.final },
  });
  assert.deepEqual(
    JSON.parse(rootCausePrompt(label, { document: null, final: null })).run,
    { document: null, final: null }
  );
  assert.throws(
    () => rootCausePrompt(makeLabel("ENG-2", { rootCause: null }), result),
    NO_ROOT_CAUSE
  );
});

test("the verdict parses strictly and keeps a one-line reason", () => {
  assert.deepEqual(
    parseRootCauseVerdict({
      grade: "partial",
      reason: " right file,\n wrong cause ",
    }),
    { grade: "partial", reason: "right file, wrong cause" }
  );
  for (const bad of [
    { grade: "maybe", reason: "x" },
    { grade: "match" },
    { grade: "match", reason: "" },
    { extra: true, grade: "match", reason: "x" },
    "match",
  ]) {
    assert.throws(() => parseRootCauseVerdict(bad));
  }
});

test("the judge stops at maxCalls and throws before the next call", async () => {
  const calls: { input: string; system: string }[] = [];
  const fake: RootCauseRunner = (system, input) => {
    calls.push({ input, system });
    return Promise.resolve({ grade: "match", reason: "same place" });
  };
  const judge = rootCauseJudge(2, fake);
  assert.equal((await judge.judge(label, result)).grade, "match");
  await judge.judge(makeLabel("ENG-2"), result);
  await assert.rejects(judge.judge(makeLabel("ENG-3"), result), CAP);
  assert.equal(calls.length, 2);
  assert.equal(judge.calls, 2);
  assert.equal(calls[0].system, ROOT_CAUSE_PROMPT);
  assert.throws(() => rootCauseJudge(-1, fake), BAD_CAP);
  assert.equal(JUDGE_TIMEOUT_MS, 240_000);
});

test("no more than three judge calls run at once", async () => {
  let active = 0;
  let peak = 0;
  const fake: RootCauseRunner = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { grade: "wrong", reason: "different defect" };
  };
  const judge = rootCauseJudge(6, fake);
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      judge.judge(makeLabel(`ENG-${index + 1}`), result)
    )
  );
  assert.equal(peak, 3);
});

test("the root-cause judge waits for the claude -p slots it shares with the widget judge", async () => {
  const releases: (() => void)[] = [];
  const held = Array.from({ length: 3 }, () =>
    withClaudeSlot(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    )
  );
  let started = false;
  const judge = rootCauseJudge(1, () => {
    started = true;
    return Promise.resolve({ grade: "match", reason: "Same place." });
  });
  const pending = judge.judge(label, result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  for (const release of releases) {
    release();
  }
  await Promise.all(held);
  assert.equal((await pending).grade, "match");
  assert.equal(started, true);
});
