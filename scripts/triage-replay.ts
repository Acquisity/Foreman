import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPLAY_SECRET_HEADER } from "../agent/lib/triage-replay/route.js";
import { triageCaseSchema } from "../agent/lib/triage-replay/schema.js";

interface Polled {
  result: { status: string };
  settled: boolean;
}

const COHORT = "evals/triage";
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 30_000;

const { values } = parseArgs({
  options: {
    archives: { type: "string" },
    cases: { type: "string" },
    out: { type: "string" },
    "run-id": { type: "string" },
    runs: { default: "1", type: "string" },
    split: { type: "string" },
    "timeout-s": { default: "1800", type: "string" },
    url: { type: "string" },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const secret =
  process.env.FOREMAN_DIAGNOSTICS_SECRET ??
  fail("Set FOREMAN_DIAGNOSTICS_SECRET.");
const server = values.url ?? fail("--url is required.");
const runId = values["run-id"] ?? fail("--run-id is required.");
const archives = JSON.parse(
  readFileSync(values.archives ?? fail("--archives is required."), "utf8")
) as Record<string, string>;
const readJson = (...path: string[]) =>
  JSON.parse(readFileSync(join(COHORT, ...path), "utf8"));
const split = readJson("split.json") as Record<string, string[]>;
const ids =
  values.cases?.split(",") ??
  split[values.split ?? ""] ??
  fail("Pass --cases or --split heldout|train.");
const lists = Object.fromEntries(
  ["labels", "projects", "states", "users"].map((name) => [
    name,
    readJson("frozen", `${name}.json`),
  ])
);

const out = values.out ?? join(".eve", "triage-replay", runId);
mkdirSync(out, { recursive: true });
const headers = {
  "content-type": "application/json",
  [REPLAY_SECRET_HEADER]: secret,
};
const runs = Number(values.runs);
const deadlineMs = Number(values["timeout-s"]) * 1000;
const missing: string[] = [];

async function replay(id: string, run: number) {
  const triageCase = triageCaseSchema.parse(readJson("cases", `${id}.json`));
  const archiveUrl =
    archives[triageCase.repoCommitAtCreate] ??
    fail(`No archive for ${id}'s commit.`);
  const started = await fetch(`${server}/internal/triage/replay`, {
    body: JSON.stringify({ archiveUrl, case: triageCase, lists, run, runId }),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await started.json()) as { caseKey?: string; error?: string };
  if (!(started.ok && body.caseKey)) {
    console.error(`${id} run ${run}: not started (${body.error})`);
    return null;
  }
  const query = new URLSearchParams({ caseKey: body.caseKey, runId });
  const until = Date.now() + deadlineMs;
  let last: Polled | null = null;
  while (Date.now() < until && !last?.settled) {
    // biome-ignore lint/performance/noAwaitInLoops: polling waits between reads by design.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const polled = await fetch(
      `${server}/internal/triage/replay/result?${query}`,
      { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (polled.ok) {
      last = (await polled.json()) as Polled;
    }
  }
  return (
    last && (last.settled ? last.result : { ...last.result, status: "failed" })
  );
}

for (const id of ids) {
  for (let run = 1; run <= runs; run += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: replays run one at a time.
    const result = await replay(id, run);
    if (!result) {
      missing.push(`${id}#${run}`);
      continue;
    }
    writeFileSync(
      join(out, `${id}-${run}.json`),
      `${JSON.stringify(result, null, 2)}\n`
    );
    console.log(`${id} run ${run}: ${result.status}`);
  }
}
if (missing.length > 0) {
  console.error(
    `No result for ${missing.join(", ")}; each missing row scores wrong.`
  );
  process.exitCode = 1;
}
console.log(`Results in ${out}.`);
