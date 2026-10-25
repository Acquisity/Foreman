import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  type CheckDeps,
  type CheckInput,
  type CheckResult,
  type Deployment,
  ensureHistory,
  listCandidates,
  runCheckRegression,
  type Shell,
  sinceIso,
} from "./regression-lane.js";

const ADDED_RETURN = /\+ {2}return count;/u;
const ALREADY_LIVE =
  /^unchecked: the fix was already live at the failure time/u;
const TIME_UNKNOWN = /failure time is not known/u;
const NOT_SERVED = /not in the commit production serves/u;
const NO_HISTORY = /no git history/u;
const NARROW = /narrow the line range/u;
const NO_REACH = /does not reach back to the failure time/u;
const NOW = new Date("2026-10-25T12:00:00Z");
const DAY_MS = 86_400_000;
const FILE = "src/send-limit.ts";
const OTHER_FILE = "docs/notes.md";
const sandbox = mkdtempSync(join(tmpdir(), "regression-lane-"));
let counter = 0;

const at = (daysAgo: number) =>
  new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

const git = (cwd: string, args: string[], date?: string) =>
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

const shellFor = (): Shell => (command) =>
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
const sendLimit = (body: string) =>
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
const BLAMED = { end: 7, start: 5 };

class Origin {
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

const note = (name: string) => ({ [OTHER_FILE]: `notes ${name}\n` });

/** One place for the commits every planted case shares. */
const history = (origin: Origin) => {
  const base = origin.commit(
    60,
    { [FILE]: sendLimit("count"), ...note("base") },
    "base"
  );
  return { base };
};

const deps = (worktree: string, origin: Origin): CheckDeps => ({
  closeNetwork: () => Promise.resolve(),
  now: () => NOW,
  openNetwork: () => Promise.resolve(),
  remote: origin.url,
  shell: shellFor(),
  worktree,
});

const deployment = (commit: string, daysAgo: number): Deployment => ({
  commit,
  readyAt: at(daysAgo),
});

const input = (over: Partial<CheckInput> & Pick<CheckInput, "readCommit">) =>
  ({
    deployments: { current: null, timeline: [] },
    failureAt: at(8),
    failureAtSource: "claim",
    file: FILE,
    issue: "ENG-1",
    lines: BLAMED,
    ...over,
  }) satisfies CheckInput;

const recorded = (result: CheckResult) => {
  assert.equal(result.status, "recorded", JSON.stringify(result));
  assert.ok(result.status === "recorded");
  return result.record;
};

after(() => {
  execFileSync("rm", ["-rf", sandbox]);
});

describe("planted case: fixed on main and live", () => {
  it("names the fixing commit when production serves it and it shipped after the failure", async () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      20,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const earlier = origin.commit(15, note("a"), "docs: a");
    const fix = origin.commit(
      5,
      { [FILE]: sendLimit("count") },
      "fix: send limit"
    );
    const head = origin.commit(4, note("b"), "docs: b");
    const worktree = origin.clone(50);
    const evidence = {
      current: deployment(head, 4),
      timeline: [deployment(head, 4), deployment(earlier, 15)],
    };
    const first = await runCheckRegression(
      deps(worktree, origin),
      input({ deployments: evidence, readCommit: head })
    );
    assert.equal(first.status, "labels_needed");
    assert.ok(first.status === "labels_needed");
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.sha),
      [fix, bug]
    );
    assert.match(first.candidates[0]?.patch ?? "", ADDED_RETURN);

    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: evidence,
          labels: [
            { role: "fixed", sha: fix },
            { role: "introduced", sha: bug },
          ],
          readCommit: head,
        })
      )
    );
    assert.equal(record.kind, "fixed_live");
    assert.equal(record.line, `fixed on main and live, by ${fix}`);
    assert.equal(record.commit, fix);
    assert.equal(record.deployedCommit, head);
    assert.equal(record.commitRead, head);
  });

  it("still counts a fix committed before the report but first deployed after the failure", async () => {
    const origin = new Origin();
    history(origin);
    const before = origin.commit(14, note("before"), "docs: before");
    const fix = origin.commit(
      12,
      { [FILE]: sendLimit("count + 0") },
      "fix: send limit"
    );
    const worktree = origin.clone(50);
    const evidence = {
      current: deployment(fix, 6),
      timeline: [deployment(fix, 6), deployment(before, 13)],
    };
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: evidence,
          labels: [{ role: "fixed", sha: fix }],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "fixed_live");
  });

  it("does not call a fix live when it already ran at the failure time", async () => {
    const origin = new Origin();
    history(origin);
    const fix = origin.commit(
      12,
      { [FILE]: sendLimit("count + 0") },
      "fix: send limit"
    );
    const worktree = origin.clone(50);
    const evidence = {
      current: deployment(fix, 11),
      timeline: [deployment(fix, 11)],
    };
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: evidence,
          labels: [{ role: "fixed", sha: fix }],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, ALREADY_LIVE);
  });

  it("keeps the failure time uncertain when it is only the ticket's creation time", async () => {
    const origin = new Origin();
    history(origin);
    const fix = origin.commit(
      12,
      { [FILE]: sendLimit("count + 0") },
      "fix: send limit"
    );
    const worktree = origin.clone(50);
    const evidence = {
      current: deployment(fix, 11),
      timeline: [deployment(fix, 11)],
    };
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: evidence,
          failureAtSource: "ticket-created",
          labels: [{ role: "fixed", sha: fix }],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, TIME_UNKNOWN);
  });
});

describe("planted case: fixed on main, not deployed", () => {
  const setup = () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      20,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const served = origin.commit(15, note("served"), "docs: served");
    const fix = origin.commit(
      2,
      { [FILE]: sendLimit("count") },
      "fix: send limit"
    );
    return { bug, fix, origin, served, worktree: origin.clone(50) };
  };
  const labels = (fix: string, bug: string) => [
    { role: "fixed" as const, sha: fix },
    { role: "introduced" as const, sha: bug },
  ];

  it("names the fix and says it is not live when production serves an older commit", async () => {
    const { bug, fix, origin, served, worktree } = setup();
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: {
            current: deployment(served, 15),
            timeline: [deployment(served, 15)],
          },
          labels: labels(fix, bug),
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "fixed_not_deployed");
    assert.equal(record.line, `fixed on main, not deployed yet, by ${fix}`);
    assert.equal(record.deployedCommit, served);
  });

  it("treats a fix that shipped and was rolled back as not deployed", async () => {
    const { bug, fix, origin, served, worktree } = setup();
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: {
            current: deployment(served, 1),
            timeline: [deployment(fix, 2), deployment(served, 15)],
          },
          labels: labels(fix, bug),
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "fixed_not_deployed");
  });

  it("says the deploy status is unknown when no deployment can be established", async () => {
    const { bug, fix, origin, worktree } = setup();
    const records = await Promise.all(
      ([null, deployment("f".repeat(40), 3)] as (Deployment | null)[]).map(
        async (current) =>
          recorded(
            await runCheckRegression(
              deps(worktree, origin),
              input({
                deployments: { current, timeline: [] },
                labels: labels(fix, bug),
                readCommit: fix,
              })
            )
          )
      )
    );
    for (const record of records) {
      assert.equal(record.kind, "fixed_deploy_unknown");
      assert.equal(
        record.line,
        `fixed on main, deploy status unknown, by ${fix}`
      );
      assert.equal(record.deployedCommit, null);
    }
  });
});

describe("planted case: regression", () => {
  const setup = () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      10,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const head = origin.commit(9, note("after"), "docs: after");
    return { bug, head, origin, worktree: origin.clone(50) };
  };

  it("names the commit from the last 30 days that introduced it", async () => {
    const { bug, head, origin, worktree } = setup();
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: {
            current: deployment(head, 9),
            timeline: [deployment(head, 9)],
          },
          labels: [{ role: "introduced", sha: bug }],
          readCommit: head,
        })
      )
    );
    assert.equal(record.kind, "introduced");
    assert.equal(record.line, `introduced by ${bug}`);
    assert.equal(record.commit, bug);
    assert.ok(
      Date.parse(git(worktree, ["log", "-1", "--format=%cI", bug])) >=
        Date.parse(sinceIso(NOW))
    );
  });

  it("refuses an introducing commit that production does not run", async () => {
    const { bug, head, origin, worktree } = setup();
    const older = git(worktree, ["rev-parse", `${bug}~1`]);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: { current: deployment(older, 30), timeline: [] },
          labels: [{ role: "introduced", sha: bug }],
          readCommit: head,
        })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, NOT_SERVED);
  });
});

describe("later changes and labels", () => {
  const chain = () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      20,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const fix = origin.commit(
      10,
      { [FILE]: sendLimit("count") },
      "fix: send limit"
    );
    return { bug, fix, origin };
  };

  it("lets a later revert win over an earlier fix", async () => {
    const { bug, fix, origin } = chain();
    const revert = origin.commit(
      5,
      { [FILE]: sendLimit("count * 2") },
      "Revert: send limit"
    );
    const worktree = origin.clone(50);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: {
            current: deployment(revert, 4),
            timeline: [deployment(revert, 4)],
          },
          labels: [
            { role: "introduced", sha: revert },
            { role: "fixed", sha: fix },
            { role: "introduced", sha: bug },
          ],
          readCommit: revert,
        })
      )
    );
    assert.equal(record.kind, "introduced");
    assert.equal(record.commit, revert);
  });

  it("lets a later fix win over an earlier introduction", async () => {
    const { bug, fix, origin } = chain();
    const worktree = origin.clone(50);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          labels: [
            { role: "fixed", sha: fix },
            { role: "introduced", sha: bug },
          ],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "fixed_deploy_unknown");
    assert.equal(record.commit, fix);
  });

  it("ignores a commit labelled neither and refuses a missing or stray label", async () => {
    const { bug, fix, origin } = chain();
    const worktree = origin.clone(50);
    const run = (labels: CheckInput["labels"]) =>
      runCheckRegression(
        deps(worktree, origin),
        input({ labels, readCommit: fix })
      );
    const quiet = recorded(
      await run([
        { role: "neither", sha: fix },
        { role: "neither", sha: bug },
      ])
    );
    assert.equal(quiet.kind, "none");

    const missing = await run([{ role: "fixed", sha: fix }]);
    assert.ok(missing.status === "error");
    assert.ok(missing.error.includes(bug));

    const stray = await run([
      { role: "fixed", sha: fix },
      { role: "introduced", sha: bug },
      { role: "introduced", sha: "a".repeat(40) },
    ]);
    assert.ok(stray.status === "error");
  });
});

describe("history", () => {
  it("returns none for blamed code untouched for 60 days, with complete history", async () => {
    const origin = new Origin();
    history(origin);
    const head = origin.commit(3, note("recent"), "docs: recent");
    const worktree = origin.clone(50);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({ readCommit: head })
      )
    );
    assert.equal(record.kind, "none");
    assert.equal(record.line, "none");
  });

  it("deepens a shallow 50-commit clone to cover 30 days", async () => {
    const origin = new Origin();
    history(origin);
    const head = origin.bulk(240, 40, 0.1);
    const since = sinceIso(NOW);
    const inWindow = Number(
      git(origin.path, ["rev-list", "--count", `--since=${since}`, "HEAD"])
    );
    assert.ok(inWindow > 150);

    const worktree = origin.clone(50);
    const countIn = () =>
      Number(
        git(worktree, ["rev-list", "--count", `--since=${since}`, "HEAD"])
      );
    assert.equal(
      git(worktree, ["rev-parse", "--is-shallow-repository"]),
      "true"
    );
    assert.ok(countIn() < inWindow, "the 50-commit clone must start short");

    const ensured = await ensureHistory(shellFor(), {
      deploymentCommits: [],
      readCommit: head,
      remote: origin.url,
      since,
      worktree,
    });
    assert.deepEqual(ensured, { ok: true });
    assert.equal(countIn(), inWindow);
  });

  it("finds a change that only a deepened clone can see", async () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      25,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    let head = bug;
    head = origin.bulk(80, 20, 4);
    const worktree = origin.clone(50);
    assert.throws(() => git(worktree, ["cat-file", "-e", `${bug}^{commit}`]));
    const result = await runCheckRegression(
      deps(worktree, origin),
      input({ readCommit: head })
    );
    assert.ok(result.status === "labels_needed", JSON.stringify(result));
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.sha),
      [bug]
    );
  });

  it("reports unchecked, never none, when the history cannot be fetched", async () => {
    const origin = new Origin();
    history(origin);
    origin.commit(3, note("recent"), "docs: recent");
    const head = origin.bulk(60, 2, 1);
    const worktree = origin.clone(50);
    const record = recorded(
      await runCheckRegression(
        { ...deps(worktree, origin), remote: "file:///does/not/exist" },
        input({ readCommit: head })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.notEqual(record.line, "none");
  });

  it("reports unchecked when the workspace holds no git history", async () => {
    const origin = new Origin();
    const empty = join(sandbox, "archive-only");
    mkdirSync(empty);
    const record = recorded(
      await runCheckRegression(
        deps(empty, origin),
        input({ readCommit: "a".repeat(40) })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, NO_HISTORY);
  });

  it("refuses a range that more than 25 commits touched", async () => {
    const origin = new Origin();
    history(origin);
    let head = "";
    for (let i = 0; i < 27; i += 1) {
      head = origin.commit(
        20 - i / 2,
        { [FILE]: sendLimit(`count + ${i}`) },
        `tweak ${i}`
      );
    }
    const worktree = origin.clone(50);
    const listed = await listCandidates(shellFor(), {
      ...BLAME_FOR_LIST,
      readCommit: head,
      since: sinceIso(NOW),
      worktree,
    });
    assert.ok(!listed.ok);
    assert.match(listed.reason, NARROW);
  });
});

const BLAME_FOR_LIST = { file: FILE, lines: BLAMED };

describe("incomplete or mismatched deployment evidence", () => {
  const setup = () => {
    const origin = new Origin();
    history(origin);
    const served = origin.commit(15, note("served"), "docs: served");
    const fix = origin.commit(
      5,
      { [FILE]: sendLimit("count + 0") },
      "fix: send limit"
    );
    return { fix, origin, served, worktree: origin.clone(50) };
  };

  it("cannot say live when the timeline starts after the failure time", async () => {
    const { fix, origin, worktree } = setup();
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: {
            current: deployment(fix, 4),
            timeline: [deployment(fix, 4)],
          },
          labels: [{ role: "fixed", sha: fix }],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, NO_REACH);
  });

  it("cannot say live when a timeline entry is not a commit of this repository", async () => {
    const { fix, origin, served, worktree } = setup();
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({
          deployments: {
            current: deployment(fix, 4),
            timeline: [
              deployment(fix, 4),
              deployment("c".repeat(40), 9),
              deployment(served, 15),
            ],
          },
          labels: [{ role: "fixed", sha: fix }],
          readCommit: fix,
        })
      )
    );
    assert.equal(record.kind, "unchecked");
  });

  it("rejects malformed input before running any command", async () => {
    const { fix, origin, worktree } = setup();
    const ran: string[] = [];
    const spy: CheckDeps = {
      ...deps(worktree, origin),
      shell: (command) => {
        ran.push(command);
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
    };
    const results = await Promise.all(
      [
        input({ readCommit: "HEAD" }),
        input({ file: "../outside.ts", readCommit: fix }),
        input({ file: "-p", readCommit: fix }),
        input({ lines: undefined, readCommit: fix }),
        input({ needle: "x", readCommit: fix }),
        input({ failureAt: "not a date", readCommit: fix }),
      ].map((bad) => runCheckRegression(spy, bad))
    );
    for (const result of results) {
      assert.equal(result.status, "error");
    }
    assert.deepEqual(ran, []);
  });
});
