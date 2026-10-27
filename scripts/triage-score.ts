import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  triageCaseSchema,
  triageLabelSchema,
  triageResultSchema,
} from "../agent/lib/triage-replay/schema.js";
import {
  renderScorecard,
  scoreReplay,
  splitSchema,
} from "../agent/lib/triage-replay/score.js";

const USAGE =
  "Usage: pnpm triage:score <resultsDir> --heldout-labels <path> [--runs N] [--cohort evals/triage]";
const JSON_FILE = /\.json$/u;
const OUTPUTS = new Set(["scores.json"]);
const labelsSchema = z.array(triageLabelSchema);

function parseFile<T>(schema: z.ZodType<T>, path: string): T {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} is not valid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

const jsonFiles = (dir: string) =>
  readdirSync(dir)
    .filter((name) => JSON_FILE.test(name) && !OUTPUTS.has(name))
    .sort()
    .map((name) => join(dir, name));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    cohort: { default: "evals/triage", type: "string" },
    "heldout-labels": { type: "string" },
    runs: { type: "string" },
  },
});
const [results] = positionals;
const heldout = values["heldout-labels"];
if (!(results && heldout && positionals.length === 1)) {
  throw new Error(USAGE);
}
const runs = values.runs === undefined ? undefined : Number(values.runs);
if (runs !== undefined && !(Number.isInteger(runs) && runs >= 1)) {
  throw new Error(`--runs needs a whole number of at least 1.\n${USAGE}`);
}
const { cohort } = values;
const report = scoreReplay({
  cases: jsonFiles(join(cohort, "cases")).map((path) =>
    parseFile(triageCaseSchema, path)
  ),
  heldoutLabels: parseFile(labelsSchema, heldout),
  results: jsonFiles(results).map((path) =>
    parseFile(triageResultSchema, path)
  ),
  runs,
  split: parseFile(splitSchema, join(cohort, "split.json")),
  trainLabels: parseFile(labelsSchema, join(cohort, "labels", "train.json")),
});
const scorecard = renderScorecard(report);
writeFileSync(join(results, "scorecard.md"), scorecard);
writeFileSync(
  join(results, "scores.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
console.log(scorecard);
