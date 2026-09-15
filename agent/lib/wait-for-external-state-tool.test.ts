import assert from "node:assert/strict";
import { describe, it } from "node:test";
import tool from "../tools/wait_for_external_state.js";

describe("wait_for_external_state", () => {
  it("is limited to external-state polling", () => {
    assert.ok(tool.description.includes("polling an external system"));
    assert.ok(
      tool.description.includes(
        "Never use this after delegating to vision, critic, or a native agent"
      )
    );
    assert.ok(tool.description.includes("end the current turn"));
  });
});
