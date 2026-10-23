import { readFile } from "node:fs/promises";
import {
  type EvalCase,
  evaluate,
  formatSummary,
} from "../agent/lib/owner-eval.js";

const cases = JSON.parse(
  await readFile(new URL("./routing-eval.cases.json", import.meta.url), "utf8")
) as EvalCase[];
const summary = evaluate(cases);
console.log(formatSummary(summary));

const targetFlag = process.argv.indexOf("--target");
const target = targetFlag === -1 ? null : Number(process.argv[targetFlag + 1]);
if (
  target !== null &&
  summary.overall.correct / summary.overall.total < target
) {
  console.log(`below the ${target * 100}% target`);
  process.exitCode = 1;
}
