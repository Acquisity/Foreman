import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareReplayArchive, prepareReplayWorkspace } from "./archive.js";
import { auth, replayProcess } from "./fixtures.js";

const UNPACK =
  /tar -xzf .* && test ! -e \S+\/\.git && \{ mv -T \S+ \/workspace\/repo /u;
const NO_REV_PARSE = /instead of running git rev-parse HEAD/u;
const COMMIT = "a".repeat(40);
const ARCHIVE = {
  commit: COMMIT,
  url: "https://x.blob.vercel-storage.com/a.tgz",
};

function fakeSandbox(prepared = false) {
  const commands: string[] = [];
  const files: Record<string, unknown> = {};
  const sandbox = {
    run: (options: { command: string }) => {
      commands.push(options.command);
      const reuse = options.command.startsWith("test -d");
      return Promise.resolve({
        exitCode: reuse && !prepared ? 1 : 0,
        stderr: "",
        stdout: "",
      });
    },
    writeBinaryFile: (o: { content: unknown; path: string }) => {
      files[o.path] = o.content;
      return Promise.resolve();
    },
    writeTextFile: (o: { content: string; path: string }) => {
      files[o.path] = o.content;
      return Promise.resolve();
    },
  };
  return { commands, files, sandbox: sandbox as never };
}

describe("replay workspace", () => {
  it("prepares only for a replay session, and reports an unreadable archive", async (t) => {
    await replayProcess(t);
    const { sandbox } = fakeSandbox();
    assert.deepEqual(
      await prepareReplayWorkspace(null, () => Promise.resolve(sandbox)),
      {
        refusal: {
          code: "replay_session_required",
          error:
            "A replay process prepares repositories only for replay sessions.",
        },
      }
    );
    const unreadable = await prepareReplayWorkspace(auth, () =>
      Promise.resolve(sandbox)
    );
    assert.equal(
      "refusal" in unreadable && unreadable.refusal.code,
      "replay_archive_unavailable"
    );
  });

  it("returns the pinned commit and says to use it instead of rev-parse", async (t) => {
    await replayProcess(t);
    const { sandbox } = fakeSandbox(true);
    const prepared = await prepareReplayWorkspace(auth, () =>
      Promise.resolve(sandbox)
    );
    assert.ok("commit" in prepared);
    assert.equal(prepared.commit, COMMIT);
    assert.match(prepared.note, NO_REV_PARSE);
  });

  it("unpacks beside the worktree and renames it into place, writing the marker", async () => {
    const { commands, files, sandbox } = fakeSandbox();
    const error = await prepareReplayArchive(sandbox, ARCHIVE, () =>
      Promise.resolve(new Uint8Array([1, 2, 3]))
    );
    assert.equal(error, null);
    assert.match(commands[1] ?? "", UNPACK);
    assert.equal(
      JSON.parse(String(files["/workspace/.foreman/repository.json"]))
        .replayCommit,
      COMMIT
    );
  });

  it("reuses a worktree already prepared for the case's commit", async () => {
    const { commands, sandbox } = fakeSandbox(true);
    let fetched = false;
    const error = await prepareReplayArchive(sandbox, ARCHIVE, () => {
      fetched = true;
      return Promise.resolve(new Uint8Array());
    });
    assert.equal(error, null);
    assert.equal(fetched, false);
    assert.equal(commands.length, 1);
  });
});
