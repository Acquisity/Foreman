---
description: "Improving the support chat widget against its replay eval: one change per round, kept only when held-out test cases improve beyond the noise floor and every safety check passes, ending in one draft pull request or a stall report. Load only when a person explicitly asks for a widget hillclimb run. Not for triage, widget feedback tickets, or ordinary code changes."
---

# Widget hillclimb

You improve the support chat widget by changing one thing at a time and measuring the result on saved cases. You keep a change only when it helps cases you did not tune on. Nothing ships without a person approving the pull request you open.

## Before the first round

1. Prepare the `Acquisity/foreman` repository and create a branch named `hillclimb/<date>-<short-topic>`.
2. Read `evals/widget/split.json`. It lists which cases are train and which are test. Never edit it. If the file is missing, stop and say so. Do not invent a split.
3. Read the latest baseline report the person points you to. It states the noise floor: how much the test score moves between three runs of unchanged code. If there is no baseline report, stop and say so. Do not invent a noise floor.
4. Run the replay eval once on the branch as it is, and record the train score, the test score, every safety result, p90 time, and investigator cost. This is round 0.

Count only replay rows with `scored !== false`, report how many runs were not scored, and treat a case that is often not scored as a re-recording task rather than a widget failure.

## Frozen list

Never change any of these. A round that needs one of them is not a round; report it instead.

- The egress gate and its patterns (`agent/lib/widget-egress.ts`), the gate model and its prompt.
- The review policy and confidence threshold, the ownership checks, the role gate.
- The widget tool allowlist and tool budget (`agent/lib/widget-investigation-model.ts`).
- The eval itself: the cases in `evals/widget/cases/`, the graders (`agent/lib/widget-graders.ts`), the split file, the judge and its gold file, and replay (`agent/lib/widget-replay.ts`).
- Models and thresholds per stage, unless the person named that change when they asked for the run.

## One round

1. Read the failures of train cases only. For test cases, use only counts: the test score, how many test cases flipped to passing, and whether any safety check failed. Never read which test cases those are, or their questions or answers.
2. Find one cause shared by several train failures. Write it down in one sentence.
3. Make one change aimed at that cause: a prompt, an instruction file, a skill, a tool description, or a Jev question. One change per round.
4. Never paste a case's question, answer, or recorded tool output into anything you change.
5. Run the replay eval. If the change looks worth keeping, run it a second time before deciding.
6. Keep the change only when all of these hold:
   - the train score improved;
   - the test score improved by more than the noise floor, and at least two test cases flipped to passing and stayed passing on the repeat run;
   - every safety check passed on every case;
   - p90 time and investigator cost did not rise more than 10 percent without a quality gain.
7. Otherwise revert the change completely and write one line on why: train up and test flat, a score went down, a safety check failed, or time or cost rose.
8. Commit a kept change with a message that names the cause and the before and after scores.

## Stop

- Stop after 8 rounds, or after 3 rounds in a row with no kept change.
- Stop at once if a safety check fails on unchanged code: that is a broken baseline, not a round.

## Finish

- With at least one kept change: push the branch and open a draft pull request. The description lists each kept change with its cause, the train and test scores before and after, the noise floor, safety results, p90 time and cost, and every reverted round in one line each.
- With no kept change: do not push. Write a short stall report that groups the remaining train failures by cause, says which causes need a frozen-list change, and gives the round 0 numbers.
- Never mark the pull request ready and never merge it.
