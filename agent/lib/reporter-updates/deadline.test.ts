import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeadlineError, withDeadline } from "./deadline.js";

describe("withDeadline", () => {
  it("returns the work's value when it finishes in time", async () => {
    assert.equal(await withDeadline(() => Promise.resolve(7), 1000), 7);
  });

  it("rejects when the work never finishes, and aborts the signal it handed out", async () => {
    let aborted = false;
    await assert.rejects(
      withDeadline((signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<never>(() => undefined);
      }, 30),
      DeadlineError
    );
    assert.equal(aborted, true);
  });

  it("passes the work's own failure through", async () => {
    await assert.rejects(
      withDeadline(() => Promise.reject(new Error("boom")), 1000),
      { message: "boom" }
    );
  });
});
