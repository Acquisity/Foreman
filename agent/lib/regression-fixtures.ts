import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CheckDeps,
  CheckInput,
  CheckResult,
  DeployReads,
  Shell,
} from "./regression-lane.js";

/** Real git repositories in a temp directory, for the regression lane tests. */
export const NOW = new Date("2026-10-25T12:00:00Z");
export const DAY_MS = 86_400_000;
export const FILE = "src/send-limit.ts";
export const OTHER_FILE = "docs/notes.md";
const sandbox = mkdtempSync(join(tmpdir(), "regression-lane-"));
let counter = 0;

export const at = (daysAgo: number) =>
  new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

export const git = (cwd: string, args: string[], date?: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const shellFor = (): Shell => (command) =>
  new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", command],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0,
          stderr,
          stdout,
        });
      }
    );
  });

/** The blamed function, with an import of the same name above it. */
export const sendLimit = (body: string) =>
  [
    'import { computeSendLimit } from "./legacy";',
    "",
    "export const unused = computeSendLimit;",
    "",
    "export function computeSendLimit(count: number) {",
    `  return ${body};`,
    "}",
    "",
  ].join("\n");
export const BLAMED = { end: 7, start: 5 };

export class Origin {
  readonly path: string;
  constructor() {
    counter += 1;
    this.path = join(sandbox, `origin-${counter}`);
    mkdirSync(this.path);
    git(this.path, ["init", "--quiet", "-b", "main"]);
    git(this.path, ["config", "user.email", "t@example.com"]);
    git(this.path, ["config", "user.name", "t"]);
  }

  commit(daysAgo: number, files: Record<string, string>, message: string) {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(this.path, name, ".."), { recursive: true });
      writeFileSync(join(this.path, name), content);
    }
    git(this.path, ["add", "-A"], at(daysAgo));
    git(
      this.path,
      ["commit", "--quiet", "--allow-empty", "-m", message],
      at(daysAgo)
    );
    return git(this.path, ["rev-parse", "HEAD"]);
  }

  /** Many quick commits at once, through fast-import, for the dense-history test. */
  bulk(count: number, firstDaysAgo: number, lastDaysAgo: number) {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const daysAgo =
        firstDaysAgo - (i * (firstDaysAgo - lastDaysAgo)) / (count - 1);
      const seconds = Math.floor((NOW.getTime() - daysAgo * DAY_MS) / 1000);
      const message = `docs: ${i}`;
      const body = `bulk ${i}\n`;
      lines.push(
        "commit refs/heads/main",
        `committer t <t@example.com> ${seconds} +0000`,
        `data ${message.length}`,
        message,
        ...(i === 0 ? ["from refs/heads/main^0"] : []),
        `M 100644 inline ${OTHER_FILE}`,
        `data ${body.length}`,
        body.trimEnd(),
        ""
      );
    }
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: this.path,
      input: `${lines.join("\n")}\n`,
    });
    git(this.path, ["reset", "--quiet", "--hard", "main"]);
    return git(this.path, ["rev-parse", "HEAD"]);
  }

  get url() {
    return `file://${this.path}`;
  }

  clone(depth?: number) {
    counter += 1;
    const dest = join(sandbox, `clone-${counter}`);
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        ...(depth ? [`--depth=${depth}`] : []),
        this.url,
        dest,
      ],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }
    );
    return dest;
  }
}

export const note = (name: string) => ({ [OTHER_FILE]: `notes ${name}\n` });

/** One place for the commits every planted case shares. */
export const history = (origin: Origin) => {
  const base = origin.commit(
    60,
    { [FILE]: sendLimit("count"), ...note("base") },
    "base"
  );
  return { base };
};

/** Production reads answered from the origin's full history, as GitHub would. */
export const productionAt = (
  origin: Origin,
  live: string | null
): DeployReads => ({
  isAncestor: (base, head) =>
    Promise.resolve(
      spawnSync("git", ["merge-base", "--is-ancestor", base, head], {
        cwd: origin.path,
      }).status === 0
    ),
  liveSha: () => Promise.resolve(live),
});

export const deps = (
  worktree: string,
  origin: Origin,
  live: string | null = null
): CheckDeps => ({
  closeNetwork: () => Promise.resolve(),
  deploy: productionAt(origin, live),
  now: () => NOW,
  openNetwork: () => Promise.resolve(),
  remote: origin.url,
  shell: shellFor(),
  worktree,
});

export const input = (
  over: Partial<CheckInput> & Pick<CheckInput, "readCommit">
) =>
  ({
    failureAt: at(8),
    failureAtSource: "claim",
    file: FILE,
    function: "computeSendLimit",
    issue: "ENG-1",
    lines: BLAMED,
    ...over,
  }) satisfies CheckInput;

export const recorded = (result: CheckResult) => {
  assert.equal(result.status, "recorded", JSON.stringify(result));
  assert.ok(result.status === "recorded");
  return result.record;
};

export const scratch = (name: string) => join(sandbox, name);

export const removeSandbox = () => {
  execFileSync("rm", ["-rf", sandbox]);
};
