/**
 * Triage replay runner (ENG-16049). Starts each chosen case on a replay
 * server (TRIAGE_REPLAY=1, see evals/triage/README.md), one at a time, polls
 * its simulated store until it settles or times out, and writes one result
 * file per case and run for `pnpm triage:score`. It makes no model calls
 * itself; the server's run id, confirm flag and admission ledger bound spend.
 *
 * Usage:
 *   tsx scripts/triage-replay.ts --url <server> --run-id <id> --archives <map.json>
 *     (--cases ENG-1,ENG-2 | --split heldout|train) [--runs 1] [--out <dir>]
 *
 * FOREMAN_DIAGNOSTICS_SECRET must be set to the server's secret.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readCohortFiles } from "../agent/lib/triage-replay/cohort-files.js";
import { REPLAY_SECRET_HEADER } from "../agent/lib/triage-replay/route.js";
import { triageCaseSchema } from "../agent/lib/triage-replay/schema.js";
import { cohortSha256 } from "../agent/lib/triage-replay/score.js";

interface Polled {
  result: { status: string };
  settled: boolean;
}

const COHORT = "evals/triage";
const POLL_MS = 5000;
const JSON_SUFFIX = /\.json$/u;

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
const cohort = JSON.parse(
  readFileSync(join(COHORT, "cohort.json"), "utf8")
) as {
  sha256: string;
};
const cohortHash = cohortSha256(readCohortFiles(COHORT));
if (cohortHash !== cohort.sha256) {
  fail(
    `The cases or frozen lists changed since cohort.json was frozen (${cohortHash.slice(0, 12)} vs ${cohort.sha256.slice(0, 12)}). Refreeze the cohort before a replay.`
  );
}
const split = JSON.parse(readFileSync(join(COHORT, "split.json"), "utf8")) as {
  heldout: string[];
  train: string[];
};
const read = (name: string) =>
  JSON.parse(readFileSync(join(COHORT, "frozen", `${name}.json`), "utf8"));
const lists = {
  labels: read("labels"),
  projects: read("projects"),
  states: read("states"),
  users: read("users"),
};

let ids: string[];
if (values.cases) {
  ids = values.cases.split(",");
} else if (values.split === "heldout" || values.split === "train") {
  ids = split[values.split];
} else {
  ids = fail("Pass --cases or --split heldout|train.");
}
const known = new Set(
  readdirSync(join(COHORT, "cases")).map((f) => f.replace(JSON_SUFFIX, ""))
);
for (const id of ids) {
  if (!known.has(id)) {
    fail(`Unknown case ${id}.`);
  }
}

const out = values.out ?? join(".eve", "triage-replay", runId);
mkdirSync(out, { recursive: true });
const headers = {
  "content-type": "application/json",
  [REPLAY_SECRET_HEADER]: secret,
};
const runs = Number(values.runs);
const deadlineMs = Number(values["timeout-s"]) * 1000;
const refused: string[] = [];
const unread: string[] = [];
let written = 0;

for (const id of ids) {
  const triageCase = triageCaseSchema.parse(
    JSON.parse(readFileSync(join(COHORT, "cases", `${id}.json`), "utf8"))
  );
  const archiveUrl =
    archives[triageCase.repoCommitAtCreate] ??
    fail(`No archive for ${id}'s commit.`);
  for (let run = 1; run <= runs; run += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: replays run one at a time, so the server's budget is spent in order.
    const started = await fetch(`${server}/internal/triage/replay`, {
      body: JSON.stringify({
        archiveUrl,
        case: triageCase,
        cohortSha256: cohortHash,
        lists,
        run,
        runId,
      }),
      headers,
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await started.json()) as { caseKey?: string; error?: string };
    if (!(started.ok && body.caseKey)) {
      console.error(
        `${id} run ${run}: not started (${started.status}: ${body.error ?? "no reason"})`
      );
      refused.push(`${id}#${run}`);
      continue;
    }
    const query = new URLSearchParams({
      caseKey: body.caseKey,
      cohortSha256: cohortHash,
      runId,
    });
    const until = Date.now() + deadlineMs;
    let last: Polled | null = null;
    while (Date.now() < until) {
      // biome-ignore lint/performance/noAwaitInLoops: polling waits between reads by design.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const polled = await fetch(
        `${server}/internal/triage/replay/result?${query}`,
        {
          headers,
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (polled.ok) {
        last = (await polled.json()) as Polled;
        if (last?.settled) {
          break;
        }
      }
    }
    if (!last) {
      console.error(`${id} run ${run}: no result read back`);
      unread.push(`${id}#${run}`);
      continue;
    }
    const result = last.settled
      ? last.result
      : { ...last.result, status: "failed" };
    writeFileSync(
      join(out, `${id}-${run}.json`),
      `${JSON.stringify(result, null, 2)}\n`
    );
    written += 1;
    console.log(`${id} run ${run}: ${result.status}`);
  }
}
console.log(
  `${written} of ${ids.length * runs} replays wrote a result; ${refused.length} not started, ${unread.length} with no result read back.`
);
if (refused.length > 0 || unread.length > 0) {
  console.error(
    `Incomplete run: ${[...refused, ...unread].join(", ")}. Every missing row scores wrong, so raise TRIAGE_REPLAY_MAX_RUNS or TRIAGE_REPLAY_MAX_USD on the server or rerun these before scoring.`
  );
  process.exitCode = 1;
}
console.log(
  `Results in ${out}. Score them with pnpm triage:score and the sealed label file (usage in scripts/triage-score.ts).`
);
