import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { after, describe, it } from "node:test";
import {
  at,
  BLAMED,
  deps,
  FILE,
  git,
  history,
  input,
  NOW,
  note,
  Origin,
  recorded,
  removeSandbox,
  scratch,
  sendLimit,
  shellFor,
} from "./regression-fixtures.js";
import {
  type CheckInput,
  ensureHistory,
  listCandidates,
  runCheckRegression,
  sinceIso,
} from "./regression-lane.js";

const ADDED_RETURN = /\+ {2}return count;/u;
const ADDED_PLUS_ONE = /\+ {2}return count \+ 1;/u;
const ON_MAIN_BEFORE =
  /^unchecked: the fix was on main before the failure time/u;
const TIME_UNKNOWN = /failure time is not known/u;
const NOT_SERVED = /not in the commit production serves/u;
const NO_HISTORY = /no git history/u;
const NARROW = /narrow the line range/u;
const THROWN = /^unchecked: the check failed: broker down/u;
const NOT_PROVEN = /could not|Could not/u;
const NO_PATCH = /git shows no patch/u;
const NOT_PROVEN_LIVE =
  /cannot be shown to be in the commit production serves/u;
const TOO_LONG = /patch too long/u;

after(removeSandbox);

const fixedChain = (fixDaysAgo = 5) => {
  const origin = new Origin();
  history(origin);
  const bug = origin.commit(
    20,
    { [FILE]: sendLimit("count * 2") },
    "feat: double"
  );
  const older = origin.commit(15, note("a"), "docs: a");
  const fix = origin.commit(
    fixDaysAgo,
    { [FILE]: sendLimit("count") },
    "fix: send limit"
  );
  const head = origin.commit(fixDaysAgo - 1, note("b"), "docs: b");
  return { bug, fix, head, older, origin };
};

const bothLabels = (fix: string, bug: string): CheckInput["labels"] => [
  { role: "fixed", sha: fix },
  { role: "introduced", sha: bug },
];

describe("planted case: fixed on main and live", () => {
  it("names the fixing commit when production serves it and it landed after the failure", async () => {
    const { bug, fix, head, origin } = fixedChain();
    const worktree = origin.clone(50);
    const first = await runCheckRegression(
      deps(worktree, origin, head),
      input({ readCommit: head })
    );
    assert.ok(first.status === "labels_needed");
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.sha),
      [fix, bug]
    );
    assert.match(first.candidates[0]?.patch ?? "", ADDED_RETURN);

    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin, head),
        input({ labels: bothLabels(fix, bug), readCommit: head })
      )
    );
    assert.equal(record.kind, "fixed_live");
    assert.equal(record.line, `fixed on main and live, by ${fix}`);
    assert.equal(record.deployedCommit, head);
    assert.equal(record.commitRead, head);
    assert.equal(record.file, FILE);
    assert.deepEqual(record.lines, BLAMED);
  });

  it("does not call a fix that was on main before the failure the fix for it", async () => {
    const { bug, fix, head, origin } = fixedChain(12);
    const worktree = origin.clone(50);
    for (const [source, pattern] of [
      ["claim", ON_MAIN_BEFORE],
      ["ticket-created", TIME_UNKNOWN],
    ] as const) {
      const record = recorded(
        // biome-ignore lint/performance/noAwaitInLoops: one clone, checked twice in turn.
        await runCheckRegression(
          deps(worktree, origin, head),
          input({
            failureAtSource: source,
            labels: bothLabels(fix, bug),
            readCommit: head,
          })
        )
      );
      assert.equal(record.kind, "unchecked", source);
      assert.match(record.line, pattern, source);
    }
  });
});

describe("planted case: fixed on main, not deployed", () => {
  it("names the fix and says it is not live when production serves an older commit", async () => {
    const { bug, fix, head, older, origin } = fixedChain();
    const worktree = origin.clone(50);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin, older),
        input({ labels: bothLabels(fix, bug), readCommit: head })
      )
    );
    assert.equal(record.kind, "fixed_not_deployed");
    assert.equal(record.line, `fixed on main, not deployed yet, by ${fix}`);
    assert.equal(record.deployedCommit, older);
  });

  it("says the deploy status is unknown when production's commit or ancestry can't be read", async () => {
    const { bug, fix, head, origin } = fixedChain();
    const worktree = origin.clone(50);
    const run = (deploy: ReturnType<typeof deps>["deploy"]) =>
      runCheckRegression(
        { ...deps(worktree, origin), deploy },
        input({ labels: bothLabels(fix, bug), readCommit: head })
      );
    for (const deploy of [
      {
        isAncestor: () => Promise.resolve(true),
        liveSha: () => Promise.resolve(null),
      },
      {
        isAncestor: () => Promise.resolve(true),
        liveSha: () => Promise.reject(new Error("HTTP 404")),
      },
      {
        isAncestor: () => Promise.reject(new Error("HTTP 403")),
        liveSha: () => Promise.resolve(head),
      },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one clone, checked in turn.
      const record = recorded(await run(deploy));
      assert.equal(record.kind, "fixed_deploy_unknown");
      assert.equal(
        record.line,
        `fixed on main, deploy status unknown, by ${fix}`
      );
    }
  });
});

describe("planted case: regression", () => {
  const regressed = () => {
    const origin = new Origin();
    history(origin);
    const old = origin.commit(12, note("old"), "docs: old");
    const bug = origin.commit(
      10,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const head = origin.commit(9, note("after"), "docs: after");
    return { bug, head, old, origin };
  };

  it("names the commit from the last 30 days that introduced it", async () => {
    const { bug, head, origin } = regressed();
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin, head),
        input({ labels: [{ role: "introduced", sha: bug }], readCommit: head })
      )
    );
    assert.equal(record.line, `introduced by ${bug}`);
    assert.ok(Date.parse(at(30)) < Date.parse(at(10)));
  });

  it("never names an introducing commit when production's commit or ancestry can't be read", async () => {
    const { bug, head, origin } = regressed();
    const worktree = origin.clone(50);
    for (const deploy of [
      {
        isAncestor: () => Promise.resolve(true),
        liveSha: () => Promise.resolve(null),
      },
      {
        isAncestor: () => Promise.reject(new Error("HTTP 403")),
        liveSha: () => Promise.resolve(head),
      },
    ]) {
      const record = recorded(
        // biome-ignore lint/performance/noAwaitInLoops: one clone, checked in turn.
        await runCheckRegression(
          { ...deps(worktree, origin), deploy },
          input({
            labels: [{ role: "introduced", sha: bug }],
            readCommit: head,
          })
        )
      );
      assert.equal(record.kind, "unchecked");
      assert.match(record.line, NOT_PROVEN_LIVE);
    }
  });

  it("refuses an introducing commit that production does not run", async () => {
    const { bug, head, old, origin } = regressed();
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin, old),
        input({ labels: [{ role: "introduced", sha: bug }], readCommit: head })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, NOT_SERVED);
  });
});

describe("later changes and labels", () => {
  it("lets a later revert win over an earlier fix, and a later fix over an introduction", async () => {
    const { bug, fix, origin } = fixedChain();
    const revert = origin.commit(
      2,
      { [FILE]: sendLimit("count * 2") },
      "Revert: send limit"
    );
    const worktree = origin.clone(50);
    const reverted = recorded(
      await runCheckRegression(
        deps(worktree, origin, revert),
        input({
          labels: [
            { role: "introduced", sha: revert },
            ...(bothLabels(fix, bug) ?? []),
          ],
          readCommit: revert,
        })
      )
    );
    assert.equal(reverted.line, `introduced by ${revert}`);
    const fixed = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({ labels: bothLabels(fix, bug), readCommit: fix })
      )
    );
    assert.equal(fixed.kind, "fixed_deploy_unknown");
  });

  it("ignores a commit labelled neither and refuses a missing or stray label", async () => {
    const { bug, fix, origin } = fixedChain();
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
    assert.ok(missing.status === "error" && missing.error.includes(bug));
    const stray = await run([
      ...(bothLabels(fix, bug) ?? []),
      { role: "introduced", sha: "a".repeat(40) },
    ]);
    assert.ok(stray.status === "error");
  });
});

describe("patches follow the lines through moves", () => {
  it("shows each commit's change to the blamed lines where they were then, not at today's coordinates", async () => {
    const origin = new Origin();
    history(origin);
    const fix = origin.commit(
      6,
      { [FILE]: sendLimit("count + 1") },
      "fix: send limit"
    );
    const moved = origin.commit(
      4,
      {
        [FILE]: `${"// header\n".repeat(20)}${sendLimit("count + 1")}`,
      },
      "chore: add a header"
    );
    const record = await runCheckRegression(
      deps(origin.clone(50), origin),
      input({ lines: { end: 27, start: 25 }, readCommit: moved })
    );
    assert.ok(record.status === "labels_needed", JSON.stringify(record));
    const patch =
      record.candidates.find((candidate) => candidate.sha === fix)?.patch ?? "";
    assert.match(patch, ADDED_PLUS_ONE);
    assert.ok(!record.candidates.some((candidate) => candidate.sha === moved));
  });
});

describe("history", () => {
  it("returns none for blamed code untouched for 60 days, with complete history", async () => {
    const origin = new Origin();
    history(origin);
    const head = origin.commit(3, note("recent"), "docs: recent");
    const record = recorded(
      await runCheckRegression(
        deps(origin.clone(50), origin),
        input({ readCommit: head })
      )
    );
    assert.equal(record.line, "none");
  });

  it("never names a shallow boundary inside the window as the introducing commit", async () => {
    const origin = new Origin();
    history(origin);
    origin.commit(40, note("old"), "docs: old");
    const head = origin.commit(25, note("inside"), "docs: inside");
    const worktree = origin.clone(1);
    assert.equal(
      git(worktree, ["rev-parse", "--is-shallow-repository"]),
      "true"
    );
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin),
        input({ readCommit: head })
      )
    );
    assert.equal(record.line, "none");
    const cut = origin.clone(1);
    const offline = recorded(
      await runCheckRegression(
        { ...deps(cut, origin), remote: "file:///does/not/exist" },
        input({ readCommit: head })
      )
    );
    assert.equal(offline.kind, "unchecked");
    assert.match(offline.line, NOT_PROVEN);
  });

  it("deepens a shallow 50-commit clone until 30 days are proven complete", async () => {
    const origin = new Origin();
    history(origin);
    const head = origin.bulk(240, 40, 0.1);
    const since = sinceIso(NOW);
    const inWindow = Number(
      git(origin.path, ["rev-list", "--count", `--since=${since}`, "HEAD"])
    );
    const worktree = origin.clone(50);
    const countIn = () =>
      Number(
        git(worktree, ["rev-list", "--count", `--since=${since}`, "HEAD"])
      );
    assert.ok(countIn() < inWindow, "the 50-commit clone must start short");
    const ensured = await ensureHistory(shellFor(), {
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
    const head = origin.bulk(80, 20, 4);
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
    const head = origin.bulk(60, 2, 1);
    const record = recorded(
      await runCheckRegression(
        { ...deps(origin.clone(50), origin), remote: "file:///does/not/exist" },
        input({ readCommit: head })
      )
    );
    assert.equal(record.kind, "unchecked");
  });

  it("reports unchecked when the workspace holds no git history", async () => {
    const empty = scratch("archive-only");
    mkdirSync(empty);
    const record = recorded(
      await runCheckRegression(
        deps(empty, new Origin()),
        input({ readCommit: "a".repeat(40) })
      )
    );
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
    const listed = await listCandidates(shellFor(), {
      file: FILE,
      lines: BLAMED,
      readCommit: head,
      since: sinceIso(NOW),
      worktree: origin.clone(50),
    });
    assert.ok(!listed.ok);
    assert.match(listed.reason, NARROW);
  });
});

describe("merges whose change git log -L cannot show", () => {
  const mergeResolution = () => {
    const origin = new Origin();
    history(origin);
    git(origin.path, ["checkout", "--quiet", "-b", "side"]);
    const side = origin.commit(
      12,
      { [FILE]: sendLimit("count * 2") },
      "feat: side"
    );
    git(origin.path, ["checkout", "--quiet", "main"]);
    const main = origin.commit(
      11,
      { [FILE]: sendLimit("count * 3") },
      "feat: main"
    );
    spawnSync("git", ["merge", "--quiet", "--no-edit", "side"], {
      cwd: origin.path,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const merge = origin.commit(
      6,
      { [FILE]: sendLimit("count") },
      "Merge side, resolving the limit"
    );
    return { main, merge, origin, side };
  };

  it("never asks for a label without a patch, and a merge newer than the decisive commit leaves it unchecked", async () => {
    const { main, merge, origin, side } = mergeResolution();
    const worktree = origin.clone(50);
    const first = await runCheckRegression(
      deps(worktree, origin, merge),
      input({ readCommit: merge })
    );
    assert.ok(first.status === "labels_needed", JSON.stringify(first));
    const shas = first.candidates.map((candidate) => candidate.sha);
    assert.ok(!shas.includes(merge));
    assert.ok(first.candidates.every((candidate) => candidate.patch.trim()));
    assert.deepEqual([...shas].sort(), [main, side].sort());
    assert.deepEqual(first.unavailable, [
      { reason: "git shows no patch for the merge", sha: merge },
    ]);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin, merge),
        input({
          labels: [
            { role: "introduced", sha: main },
            { role: "introduced", sha: side },
          ],
          readCommit: merge,
        })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, NO_PATCH);
    assert.ok(record.line.includes(merge));
    const labelled = await runCheckRegression(
      deps(worktree, origin, merge),
      input({
        labels: [
          { role: "fixed", sha: merge },
          { role: "introduced", sha: main },
          { role: "introduced", sha: side },
        ],
        readCommit: merge,
      })
    );
    assert.equal(labelled.status, "error");
  });
});

describe("patches too long to show whole", () => {
  it("never offers a cut patch for a label, and a long one newer than the decisive commit leaves it unchecked", async () => {
    const origin = new Origin();
    history(origin);
    const bug = origin.commit(
      12,
      { [FILE]: sendLimit("count * 2") },
      "feat: double"
    );
    const long = origin.commit(
      6,
      { [FILE]: sendLimit(`count + ${"1 + ".repeat(1500)}0`) },
      "refactor: a very long expression"
    );
    const worktree = origin.clone(50);
    const first = await runCheckRegression(
      deps(worktree, origin, long),
      input({ readCommit: long })
    );
    assert.ok(
      first.status === "labels_needed",
      JSON.stringify(first).slice(0, 300)
    );
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.sha),
      [bug]
    );
    assert.deepEqual(first.unavailable, [
      { reason: "patch too long", sha: long },
    ]);
    const record = recorded(
      await runCheckRegression(
        deps(worktree, origin, long),
        input({ labels: [{ role: "introduced", sha: bug }], readCommit: long })
      )
    );
    assert.equal(record.kind, "unchecked");
    assert.match(record.line, TOO_LONG);
    assert.ok(record.line.includes(long));
  });
});

describe("operational failures", () => {
  it("turns a thrown error anywhere into unchecked and still closes the network", async () => {
    const origin = new Origin();
    history(origin);
    const head = origin.commit(3, note("recent"), "docs: recent");
    const worktree = origin.clone(50);
    let closed = 0;
    const broken = await runCheckRegression(
      {
        ...deps(worktree, origin),
        closeNetwork: () => {
          closed += 1;
          return Promise.resolve();
        },
        openNetwork: () => Promise.reject(new Error("broker down")),
      },
      input({ readCommit: head })
    );
    assert.match(recorded(broken).line, THROWN);
    assert.equal(closed, 0);
    const shellThrows = await runCheckRegression(
      {
        ...deps(worktree, origin),
        closeNetwork: () => {
          closed += 1;
          return Promise.resolve();
        },
        shell: () => Promise.reject(new Error("broker down")),
      },
      input({ readCommit: head })
    );
    assert.match(recorded(shellThrows).line, THROWN);
    assert.equal(closed, 1);
  });

  it("rejects malformed input before running any command", async () => {
    const origin = new Origin();
    let ran = false;
    const result = await runCheckRegression(
      {
        ...deps(scratch("never"), origin),
        shell: () => {
          ran = true;
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        },
      },
      input({ lines: { end: 1, start: 3 }, readCommit: "a".repeat(40) })
    );
    assert.equal(result.status, "error");
    assert.equal(ran, false);
  });
});
