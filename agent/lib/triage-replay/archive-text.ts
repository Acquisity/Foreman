import { spawn } from "node:child_process";
import { type LeakageHit, NON_WORD } from "./leakage.js";
import { REPLAY_SANDBOX_TOOLS } from "./tool-policy.js";

export type ArchiveNeedle = Pick<LeakageHit, "kind" | "match">;
export type ArchiveScanner = (
  commit: string,
  needles: readonly ArchiveNeedle[]
) => Promise<ReadonlySet<string>>;

const RAW_TAIL = 256;
const GIT_TIMEOUT_MS = 900_000;
const STDERR_LIMIT = 2000;
const LITERAL = /[.*+?^${}()|[\]\\/]/gu;

export const needleKey = ({ kind, match }: ArchiveNeedle) =>
  `${kind}\u0000${match}`;

const escaped = (text: string) => text.replace(LITERAL, "\\$&");

type Probe = (raw: string, flat: string) => boolean;

function probeFor({ kind, match }: ArchiveNeedle): Probe {
  if (kind === "fix_commit") {
    const token = new RegExp(`(?<!\\w)${escaped(match)}(?!\\w)`, "iu");
    return (raw) => token.test(raw);
  }
  if (kind === "fix_pr") {
    const lead = match.startsWith("#") ? "(?<![\\w#])" : "";
    const reference = new RegExp(`${lead}${escaped(match)}(?!\\d)`, "iu");
    return (raw) => reference.test(raw);
  }
  const phrase = ` ${match} `;
  return (_raw, flat) => flat.includes(phrase);
}

class ArchiveScan {
  private raw = "";
  private flat = " ";
  private readonly flatTail: number;
  private readonly open: Map<string, Probe>;
  readonly found = new Set<string>();

  constructor(needles: readonly ArchiveNeedle[]) {
    this.open = new Map(
      needles.map((needle) => [needleKey(needle), probeFor(needle)])
    );
    this.flatTail =
      Math.max(0, ...needles.map(({ match }) => match.length)) + 2;
  }

  get done() {
    return this.open.size === 0;
  }

  feed(text: string) {
    const normalized = text.toLowerCase().replace(NON_WORD, " ");
    const raw = this.raw + text;
    const flat =
      this.flat.endsWith(" ") && normalized.startsWith(" ")
        ? this.flat + normalized.slice(1)
        : this.flat + normalized;
    for (const [key, probe] of this.open) {
      if (probe(raw, flat)) {
        this.found.add(key);
        this.open.delete(key);
      }
    }
    this.raw = raw.slice(-RAW_TAIL);
    this.flat = flat.slice(-this.flatTail);
  }
}

async function streamGit(
  checkout: string,
  args: readonly string[],
  onText: (text: string) => boolean
): Promise<void> {
  const child = spawn("git", ["-C", checkout, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr += data.toString("utf8");
    }
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let satisfied = false;
  for await (const chunk of child.stdout) {
    if (onText(chunk as string)) {
      satisfied = true;
      child.kill();
      break;
    }
  }
  const code = await closed;
  if (!satisfied && (code === null || code > 1)) {
    throw new Error(
      `git ${args.slice(0, 2).join(" ")} failed in ${checkout} (${code ?? "killed"}): ${stderr.trim().slice(0, 300)}`
    );
  }
}

export const gitArchiveScanner =
  (checkout: string): ArchiveScanner =>
  async (commit, needles) => {
    const scan = new ArchiveScan(needles);
    const feed = (text: string) => {
      scan.feed(text);
      return scan.done;
    };
    await streamGit(
      checkout,
      ["ls-tree", "-r", "-z", "--name-only", `${commit}^{tree}`],
      feed
    );
    if (!scan.done) {
      scan.feed("\n");
      await streamGit(
        checkout,
        ["grep", "-a", "-h", "-e", "", `${commit}^{tree}`],
        feed
      );
    }
    return scan.found;
  };

export const isSandboxHit = (hit: Pick<LeakageHit, "source">) =>
  REPLAY_SANDBOX_TOOLS.has(hit.source);

export interface ScoredRow {
  commit: string | undefined;
  hits: LeakageHit[];
  key: string;
}

export async function keepArchiveBackedHits(
  rows: readonly ScoredRow[],
  scan: ArchiveScanner | undefined
): Promise<Map<string, LeakageHit[]>> {
  const sandboxRows = rows.filter(({ hits }) => hits.some(isSandboxHit));
  if (!scan) {
    if (sandboxRows.length > 0) {
      throw new Error(
        `Refusing to score: ${sandboxRows.map(({ key }) => key).join(", ")} flagged text a replay read from its sandbox, which counts only when the case's repository archive holds it, and --acquisity names no checkout to check against.`
      );
    }
    return new Map(rows.map(({ hits, key }) => [key, hits]));
  }
  const needlesByCommit = new Map<string, Map<string, ArchiveNeedle>>();
  for (const { commit, hits, key } of sandboxRows) {
    if (commit === undefined) {
      throw new Error(`Refusing to score: ${key} has no case commit.`);
    }
    const needles = needlesByCommit.get(commit) ?? new Map();
    for (const hit of hits.filter(isSandboxHit)) {
      needles.set(needleKey(hit), hit);
    }
    needlesByCommit.set(commit, needles);
  }
  const archived = new Map<string, ReadonlySet<string>>();
  for (const [commit, needles] of needlesByCommit) {
    // biome-ignore lint/performance/noAwaitInLoops: one archive scan at a time keeps git's load to one process.
    const found = await scan(commit, [...needles.values()]);
    archived.set(commit, found);
  }
  return new Map(
    rows.map(({ commit, hits, key }) => [
      key,
      hits.filter(
        (hit) =>
          !isSandboxHit(hit) ||
          (commit !== undefined &&
            archived.get(commit)?.has(needleKey(hit)) === true)
      ),
    ])
  );
}
