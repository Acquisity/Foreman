import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareReplayArchive, prepareReplayWorkspace } from "./archive.js";
import { auth, replayProcess } from "./fixtures.js";

const UNPACK = /tar -xzf .* && test ! -e \/workspace\/repo\/\.git/u;

describe("replay workspace", () => {
  it("prepares only for a replay session, and reports an unreadable archive", async (t) => {
    await replayProcess(t);
    const sandbox = {
      run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
      writeBinaryFile: () => Promise.resolve(),
      writeTextFile: () => Promise.resolve(),
    } as never;
    const refused = await prepareReplayWorkspace(null, () =>
      Promise.resolve(sandbox)
    );
    assert.deepEqual(refused, {
      refusal: {
        code: "replay_session_required",
        error:
          "A replay process prepares repositories only for replay sessions.",
      },
    });
    const unreadable = await prepareReplayWorkspace(auth, () =>
      Promise.resolve(sandbox)
    );
    assert.equal(
      "refusal" in unreadable && unreadable.refusal.code,
      "replay_archive_unavailable"
    );
  });

  it("unpacks the pinned archive with no history and writes the repository marker", async () => {
    const commands: string[] = [];
    const files: Record<string, unknown> = {};
    const sandbox = {
      run: (options: { command: string }) => {
        commands.push(options.command);
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
      writeBinaryFile: (o: { content: unknown; path: string }) => {
        files[o.path] = o.content;
        return Promise.resolve();
      },
      writeTextFile: (o: { content: string; path: string }) => {
        files[o.path] = o.content;
        return Promise.resolve();
      },
    } as never;
    const error = await prepareReplayArchive(
      sandbox,
      {
        commit: "a".repeat(40),
        url: "https://x.blob.vercel-storage.com/a.tgz",
      },
      () => Promise.resolve(new Uint8Array([1, 2, 3]))
    );
    assert.equal(error, null);
    assert.match(commands[0], UNPACK);
    assert.equal(
      JSON.parse(String(files["/workspace/.foreman/repository.json"]))
        .replayCommit,
      "a".repeat(40)
    );
  });
});
