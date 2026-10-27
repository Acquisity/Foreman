import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invokeProvider } from "../executor/dispatch.js";
import { ExecutorError } from "../executor/transport.js";
import { replayProcess } from "./fixtures.js";

describe("replay wall", () => {
  it("refuses every provider operation before it dispatches", async (t) => {
    await replayProcess(t);
    await assert.rejects(
      invokeProvider({} as never, "planetscale/readQuery", {}),
      (error) =>
        error instanceof ExecutorError &&
        error.code === "triage_replay_closed" &&
        error.dispatched === false
    );
  });
});
