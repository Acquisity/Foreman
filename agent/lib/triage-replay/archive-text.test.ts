import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  type ArchiveNeedle,
  gitArchiveScanner,
  keepArchiveBackedHits,
  needleKey,
} from "./archive-text.js";
import {
  auth,
  makeCase,
  makeLabel,
  replayHandler,
  replayProcess,
  state,
} from "./fixtures.js";
import { findLeaks, type LeakageHit } from "./leakage.js";

const GIT_FAILED = /Not a valid object name/u;
const NO_CHECKOUT = /--acquisity names no checkout/u;
const NO_COMMIT = /no case commit/u;
const FIX_COMMIT = "3f9c2b7d41e85a0c6b19d2e4f7a3c8b5d0e1f2a3";
const CAUSE =
  "The save handler cleared the cached layout early because the panel rendered twice.";
const label = makeLabel("ENG-100", {
  fixCommit: FIX_COMMIT,
  fixPr: 6108,
  rootCause: { files: [], functions: [], text: CAUSE },
});
const pr = {
  body: "Keeps the cached layout in memory until the panel finishes its second render pass.",
  title: "Keep cached layout through panel re-render",
};
const { ticket } = makeCase("ENG-100");
const baseline = `${ticket.title}\n${ticket.description}`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" }
  ).trim();

const BIG_PHRASES = Array.from({ length: 12 }, (_, i) => `zq${i} alpha beta`);
const filler = (bytes: number) =>
  "lorem ipsum dolor sit amet\n".repeat(Math.ceil(bytes / 27));

function archiveRepo(planted = true) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "archive-text-"));
  const files: Record<string, string> = {
    ...(planted
      ? {
          "docs/planted.md":
            "Older note: the save handler cleared the cached layout early.\n",
          "docs/wrapped.md": "a unique wrapped phrase\nacross lines here\n",
          [`notes/${FIX_COMMIT}.md`]: "Meeting notes.\n",
        }
      : {}),
    "big/spread.txt": BIG_PHRASES.map(
      (phrase, i) => `${filler(65_000 + i * 7)}${phrase} gamma\n`
    ).join(""),
    "src/panel.ts": "export const render = () => {\n  return true;\n};\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "case commit");
  return { commit: git(dir, "rev-parse", "HEAD"), dir };
}

const needle = (kind: ArchiveNeedle["kind"], match: string): ArchiveNeedle => ({
  kind,
  match,
});

describe("the archive scanner", () => {
  it("finds a phrase across a line break, a name that is only a file path, and a phrase near every chunk boundary", async () => {
    const { commit, dir } = archiveRepo();
    const wanted = [
      needle("pr_body", "unique wrapped phrase across lines here"),
      needle("fix_commit", FIX_COMMIT),
      ...BIG_PHRASES.map((phrase) => needle("pr_body", `${phrase} gamma`)),
    ];
    const absent = [
      needle("root_cause", "layout cleared the handler save cached"),
      needle("fix_commit", "0123456789abcdef"),
      needle("fix_commit", FIX_COMMIT.slice(0, 7).toUpperCase()),
      needle("fix_pr", "#6108"),
      needle("fix_pr", "/pull/6108"),
    ];
    const found = await gitArchiveScanner(dir)(commit, [...wanted, ...absent]);
    assert.deepEqual(
      [...found].sort((a, b) => a.localeCompare(b)),
      wanted.map(needleKey).sort((a, b) => a.localeCompare(b))
    );
  });

  it("matches a PR number only as a whole reference", async () => {
    const { commit, dir } = archiveRepo();
    writeFileSync(join(dir, "src/refs.ts"), "see #61080 and #610\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "refs");
    const scan = gitArchiveScanner(dir);
    assert.equal(
      (await scan(git(dir, "rev-parse", "HEAD"), [needle("fix_pr", "#6108")]))
        .size,
      0
    );
    writeFileSync(join(dir, "src/refs.ts"), "see #6108.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ref");
    assert.equal(
      (await scan(git(dir, "rev-parse", "HEAD"), [needle("fix_pr", "#6108")]))
        .size,
      1
    );
    assert.equal((await scan(commit, [needle("fix_pr", "#6108")])).size, 0);
  });

  it("refuses a commit the checkout doesn't have, instead of finding nothing", async () => {
    const { dir } = archiveRepo();
    await assert.rejects(
      gitArchiveScanner(dir)("f".repeat(40), [needle("fix_pr", "#6108")]),
      GIT_FAILED
    );
  });
});

describe("leakage in what a replay read from its sandbox", () => {
  const rootCtx = {
    cancel: () => undefined,
    session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
  };
  let call = 0;
  const run = async (
    toolName: string,
    input: Record<string, unknown>,
    output: unknown
  ) => {
    call += 1;
    const callId = `call-${call}`;
    await replayHandler("actions.requested")(
      { data: { actions: [{ callId, input, kind: "tool-call", toolName }] } },
      rootCtx
    );
    await replayHandler("action.result")(
      {
        data: {
          result: {
            callId,
            isError: false,
            kind: "tool-result",
            output,
            toolName,
          },
        },
      },
      rootCtx
    );
  };
  const scan = async (t: TestContext, dir: string, commit: string) => {
    const { inputs } = await state();
    const hits = findLeaks({ baseline, label, pr, result: { inputs } });
    const kept = await keepArchiveBackedHits(
      [{ commit, hits, key: "ENG-100#1" }],
      gitArchiveScanner(dir)
    );
    t.diagnostic(
      `${hits.length} flagged, ${kept.get("ENG-100#1")?.length} kept`
    );
    return { hits, kept: kept.get("ENG-100#1") ?? [] };
  };

  it("does not count a correct cause the run wrote to scratch and read back, however it wrote and read it", async (t) => {
    const { commit, dir } = archiveRepo(false);
    await replayProcess(t);
    await run("write_file", { content: CAUSE, filePath: "/tmp/a.md" }, "wrote");
    await run(
      "bash",
      { command: `cat > /tmp/b.md <<'EOF'\n${CAUSE}\nEOF` },
      { exitCode: 0, stdout: "" }
    );
    await run(
      "bash",
      { command: `python3 -c "open('/tmp/c.md','w').write('${CAUSE}')"` },
      { exitCode: 0, stdout: "" }
    );
    await run(
      "bash",
      { command: "cat /tmp/c.md" },
      { exitCode: 0, stdout: CAUSE }
    );
    await run("read_file", { path: "/tmp/a.md" }, { content: CAUSE });
    await run(
      "grep",
      { path: "/tmp", pattern: "cleared" },
      { content: `/tmp/b.md:1:${CAUSE}` }
    );
    const { hits, kept } = await scan(t, dir, commit);
    assert.deepEqual([...new Set(hits.map(({ source }) => source))].sort(), [
      "bash",
      "grep",
      "read_file",
    ]);
    assert.deepEqual(kept, []);
  });

  it("counts a phrase planted in a file at the case commit, and a fix SHA that is only a file name, even after scratch that overlaps them", async (t) => {
    const { commit, dir } = archiveRepo();
    await replayProcess(t);
    await run(
      "write_file",
      { content: "return true;", filePath: "/tmp/a.md" },
      "wrote"
    );
    await run(
      "bash",
      { command: "cat docs/planted.md" },
      {
        exitCode: 0,
        stdout:
          "Older note: the save handler cleared the cached layout early.\n",
      }
    );
    await run(
      "grep",
      { path: ".", pattern: "return" },
      { content: `notes/${FIX_COMMIT}.md:1:return true;` }
    );
    const { kept } = await scan(t, dir, commit);
    assert.deepEqual(
      kept.map(({ kind, source }) => [kind, source]),
      [
        ["root_cause", "bash"],
        ["fix_commit", "grep"],
      ]
    );
  });

  it("still counts a store input that carries the fix PR's text, with no checkout needed", () => {
    const hits = findLeaks({
      baseline,
      label,
      pr,
      result: {
        inputs: [
          {
            availableAt: null,
            content: `Related: fixed in #6108. ${pr.title}.`,
            provenance: "seeded",
            source: "find_related_issues",
          },
        ],
      },
    });
    assert.deepEqual(
      hits.map(({ kind }) => kind),
      ["fix_pr", "pr_title"]
    );
    return keepArchiveBackedHits(
      [{ commit: undefined, hits, key: "ENG-100#1" }],
      undefined
    ).then((kept) => assert.deepEqual(kept.get("ENG-100#1"), hits));
  });

  it("refuses to score a sandbox hit without a checkout, or with no case commit", async () => {
    const hit: LeakageHit = {
      availableAt: null,
      kind: "fix_pr",
      match: "#6108",
      source: "bash",
    };
    await assert.rejects(
      keepArchiveBackedHits(
        [{ commit: "a".repeat(40), hits: [hit], key: "k" }],
        undefined
      ),
      NO_CHECKOUT
    );
    const { dir } = archiveRepo();
    await assert.rejects(
      keepArchiveBackedHits(
        [{ commit: undefined, hits: [hit], key: "k" }],
        gitArchiveScanner(dir)
      ),
      NO_COMMIT
    );
  });
});
