import assert from "node:assert/strict";
import { describe, it } from "node:test";
import tool from "../tools/sleep.js";

describe("sleep", () => {
  it("keeps delegated-task delivery out of external-state polling", () => {
    assert.ok(
      tool.description.includes(
        "not to wait for vision, critic, or native-agent results"
      )
    );
  });
});
