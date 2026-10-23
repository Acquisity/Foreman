import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareReplayWorkspace } from "./archive.js";
import { auth, replayProcess } from "./fixtures.js";

describe("replay workspace", () => {
  it("prepares only the case's pinned archive, from archive.ts", async (t) => {
    await replayProcess(t);
    const sandbox = {
      run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
      writeBinaryFile: () => Promise.resolve(),
      writeTextFile: () => Promise.resolve(),
    } as never;
    t.mock.method(globalThis, "fetch", () => {
      throw new Error("no network in a replay");
    });
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
});
