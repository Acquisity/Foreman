const EXPECTED_ERROR_1 = /repeated/u;
const EXPECTED_ERROR_2 = /too many/u;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  OperationRequest,
  ProviderClient,
} from "./executor/operations.js";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
} from "./instantly-api.js";
import {
  inputOf,
  json,
  member,
  SECOND_WORKSPACE_ID,
  uuidFor,
} from "./instantly-fixtures.js";

describe("Instantly complete membership", () => {
  it("follows every page and retains only accepted membership with provenance", async () => {
    const calls: OperationRequest[] = [];
    const client: ProviderClient = (request) => {
      calls.push(request);
      return inputOf(request).starting_after
        ? json({
            items: [
              member({ sub_workspace_id: SECOND_WORKSPACE_ID }),
              member({ status: "pending" }),
              member({ status: "rejected" }),
            ],
          })
        : json({ items: [member()], next_starting_after: "next" });
    };
    const result = await listInstantlySubworkspaces({ client });
    assert.equal(result.totalAcceptedSubworkspaces, 2);
    assert.deepEqual(result.excludedMemberships, { pending: 1, rejected: 1 });
    assert.equal(result.membershipComplete, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {
      input: { limit: 100, starting_after: "next" },
      operation: "instantly.workspace-group-members",
    });
    assert.equal("x-as-workspace" in inputOf(calls[0]), false);
  });
  it("rejects wrong admin, malformed membership, repeated cursors, and incomplete page bounds", async () => {
    for (const body of [
      { items: [member({ admin_workspace_id: uuidFor(1) })] },
      { items: [{ id: "invalid" }] },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential cases isolate client counters and timers.
      await assert.rejects(
        listInstantlySubworkspaces({ client: () => json(body) }),
        (error) =>
          error instanceof InstantlyApiError &&
          ["invalid-response", "authorization"].includes(error.kind)
      );
    }

    await assert.rejects(
      listInstantlySubworkspaces({
        client: () => json({ items: [], next_starting_after: "same" }),
      }),
      EXPECTED_ERROR_1
    );
    let count = 0;

    await assert.rejects(
      listInstantlySubworkspaces({
        client: () => {
          count += 1;
          return json({ items: [], next_starting_after: String(count) });
        },
      }),
      EXPECTED_ERROR_2
    );
    assert.equal(count, 100);
  });
  it("rejects oversized provider pages and malformed results without returning partial membership", async () => {
    for (const body of [
      { items: [member({ sub_workspace_name: "x".repeat(300_000) })] },
      "not a page",
      null,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential cases isolate client counters and timers.
      await assert.rejects(
        listInstantlySubworkspaces({ client: () => json(body) }),
        InstantlyApiError
      );
    }
  });
});
