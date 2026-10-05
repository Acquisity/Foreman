// Claims judge review and calibration (ENG-14686).
//
//   pnpm widget:judge review [dir]  regenerate a run's review.md from its records
//   pnpm widget:judge gold [dir]    turn the marks in review.md into evals/widget/judge-gold.json
//   pnpm widget:judge rerun         judge every gold answer twice; agreement and flip rate per claim
//
// [dir] defaults to the newest run under .eve/widget-judge/. rerun calls the
// judge model through the gateway, so it needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { widgetCaseSchema } from "../agent/lib/widget-case.js";
import {
  claimsFor,
  JUDGE_MODEL,
  JUDGE_OUTPUT,
  type JudgeRecord,
  judgeAnswer,
  parseMarks,
  readRecords,
  renderReview,
  reviewedSample,
} from "../agent/lib/widget-judge.js";

import {
  calibrated,
  type GoldEntry,
  goldSchema,
  mergeGold,
  scoreAgainstGold,
  toGold,
  writeGold,
} from "../agent/lib/widget-judge-calibration.js";

const GOLD = "evals/widget/judge-gold.json";

const latestRun = () => {
  const runs = existsSync(JUDGE_OUTPUT) ? readdirSync(JUDGE_OUTPUT).sort() : [];
  if (!runs.length) {
    throw new Error(`No judge runs under ${JUDGE_OUTPUT}.`);
  }
  return `${JUDGE_OUTPUT}/${runs.at(-1)}`;
};

const readGold = (): GoldEntry[] =>
  goldSchema.parse(
    existsSync(GOLD) ? JSON.parse(readFileSync(GOLD, "utf8")) : []
  );

async function judgeGold(gold: GoldEntry[]) {
  const run = new Map<string, JudgeRecord>();
  for (const { sample } of gold) {
    // Keep the reviewed question/evidence fixed, but use today's authored claims.
    const { expectations } = widgetCaseSchema.parse(
      JSON.parse(readFileSync(`evals/widget/cases/${sample.case}.json`, "utf8"))
    );
    const recorded = { ...sample.recorded, expectations };
    const claims = claimsFor(recorded);
    // biome-ignore lint/performance/noAwaitInLoops: one judge call at a time keeps the run cheap to stop.
    const verdicts = await judgeAnswer(recorded, sample.answer, claims);
    run.set(
      sample.case,
      reviewedSample(sample.case, recorded, sample.answer, verdicts)
    );
  }
  return run;
}

const percent = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";

async function main() {
  const [command, dir = command === "rerun" ? "" : latestRun()] =
    process.argv.slice(2);
  if (command === "review") {
    writeFileSync(`${dir}/review.md`, renderReview(readRecords(dir)));
    console.log(`${dir}/review.md`);
    return;
  }
  if (command === "gold") {
    const records = readRecords(dir);
    const marks = parseMarks(readFileSync(`${dir}/review.md`, "utf8"));
    const next = toGold(records, marks);
    const rows = records.reduce(
      (sum, record) => sum + record.verdicts.length,
      0
    );
    writeGold(GOLD, mergeGold(readGold(), next));
    console.log(
      `${GOLD}: ${marks.size} of ${rows} rows marked, ${next.length} case(s) written.`
    );
    return;
  }
  if (command === "rerun") {
    const gold = readGold();
    if (!gold.some((entry) => entry.labels.length)) {
      throw new Error(`${GOLD} has no labels yet.`);
    }
    const scores = scoreAgainstGold(
      gold,
      await judgeGold(gold),
      await judgeGold(gold)
    );
    let under = scores.size === 0;
    console.log(`judge ${JUDGE_MODEL}, two runs against ${GOLD}`);
    for (const [id, score] of scores) {
      const { agree, total } = score.agreement;
      const { flipped, total: pairs } = score.flips;
      const low = !calibrated(score);
      under ||= low;
      console.log(
        `${low ? "UNDER" : "ok   "} ${id}: agreement ${percent(agree, total)} (${agree}/${total}), flips ${percent(flipped, pairs)} (${flipped}/${pairs}), coverage ${score.coverage.measured}/${score.coverage.required} (stale ${score.coverage.stale}, missing ${score.coverage.missing}, unlabelled ${score.coverage.unlabelled})`
      );
    }
    process.exitCode = under ? 1 : 0;
    return;
  }
  throw new Error("Usage: pnpm widget:judge review|gold [dir] | rerun");
}

await main();
