import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { put } from "@vercel/blob";
import { TRIAGE_REPLAY_PREFIX } from "../agent/lib/blob.js";
import { triageCaseSchema } from "../agent/lib/triage-replay/schema.js";

const COHORT = "evals/triage";
const FETCH_TIMEOUT_MS = 120_000;
const ARCHIVE_TIMEOUT_MS = 300_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    acquisity: { type: "string" },
    cases: { type: "string" },
    out: { type: "string" },
    split: { type: "string" },
  },
});
const { acquisity: checkout, out } = values;
if (!(checkout && out)) {
  console.error("--acquisity and --out are required.");
  process.exit(2);
}
const split = JSON.parse(
  readFileSync(join(COHORT, "split.json"), "utf8")
) as Record<string, string[]>;
const ids = values.cases
  ? values.cases.split(",")
  : (split[values.split ?? ""] ?? []);
const commits = new Set(
  ids.map(
    (id) =>
      triageCaseSchema.parse(
        JSON.parse(readFileSync(join(COHORT, "cases", `${id}.json`), "utf8"))
      ).repoCommitAtCreate
  )
);
execFileSync("git", ["-C", checkout, "fetch", "--quiet", "origin", "main"], {
  timeout: FETCH_TIMEOUT_MS,
});
const map: Record<string, string> = {};
for (const commit of commits) {
  const archive = execFileSync(
    "git",
    ["-C", checkout, "archive", "--format=tar.gz", commit],
    {
      maxBuffer: 1024 * 1024 * 1024,
      timeout: ARCHIVE_TIMEOUT_MS,
    }
  );
  // biome-ignore lint/performance/noAwaitInLoops: one upload at a time keeps memory to one archive.
  const blob = await put(
    `${TRIAGE_REPLAY_PREFIX}archives/${commit}.tar.gz`,
    archive,
    {
      abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      access: "private",
      addRandomSuffix: true,
      contentType: "application/gzip",
    }
  );
  map[commit] = blob.url;
  console.log(`${commit}: ${(archive.length / 1024 / 1024).toFixed(1)} MiB`);
}
writeFileSync(out, `${JSON.stringify(map, null, 2)}\n`);
console.log(`${commits.size} archives; map written to ${out}`);
