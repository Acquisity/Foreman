import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  OperationRequest,
  ProviderClient,
} from "./executor/operations.js";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
  readInstantlySubworkspace,
} from "./instantly-api.js";
import {
  inputOf,
  json,
  MAX_TEST_RESPONSE_BYTES,
  member,
  uuidFor,
  WORKSPACE_ID,
} from "./instantly-fixtures.js";

describe("Instantly large membership sets", () => {
  it("validates every membership page for a selected resource while preserving the list output cap", async () => {
    const calls: OperationRequest[] = [];
    const fetchStub: ProviderClient = (request) => {
      calls.push(request);
      if (request.operation === "instantly.workspace-group-members") {
        const second = inputOf(request).starting_after !== undefined;
        return json({
          items: Array.from({ length: 100 }, (_, index) =>
            member({
              id: uuidFor(index + (second ? 100 : 0) + 1),
              sub_workspace_id: uuidFor(index + (second ? 100 : 0) + 1),
              sub_workspace_name: "x".repeat(1400),
            })
          ),
          next_starting_after: second ? null : "second-page",
        });
      }
      assert.equal(inputOf(request)["x-as-workspace"], uuidFor(1));
      return json({
        items: [
          { id: "campaign-1", name: "Preview", smtp_password: "private" },
        ],
      });
    };
    const page = await listInstantlySubworkspaces({ client: fetchStub });
    assert.equal(calls.length, 2);
    assert.equal(page.membershipComplete, true);
    assert.equal(page.totalAcceptedSubworkspaces, 200);
    assert.equal(page.totalMatches, 200);
    assert.equal(page.subworkspaces.length, 20);
    assert.equal(page.nextStartingAfter, uuidFor(20));
    assert.ok(
      Buffer.byteLength(JSON.stringify(page)) <= MAX_TEST_RESPONSE_BYTES
    );
    calls.length = 0;
    const result = await readInstantlySubworkspace(
      { id: uuidFor(1) },
      "campaigns",
      { limit: 1 },
      { client: fetchStub }
    );
    assert.equal(calls.length, 3);
    assert.ok(inputOf(calls[1]).starting_after === "second-page");
    assert.equal(result.workspace.id, uuidFor(1));
    assert.deepEqual(result.items, [{ id: "campaign-1", name: "Preview" }]);
    assert.ok(
      Buffer.byteLength(JSON.stringify(result)) < MAX_TEST_RESPONSE_BYTES
    );
  });
});

describe("Instantly workspace discovery", () => {
  it("searches all pages by a normalized literal fragment and returns every ambiguous candidate", async () => {
    const calls: OperationRequest[] = [];
    const fetchStub: ProviderClient = (request) => {
      calls.push(request);
      return inputOf(request).starting_after === undefined
        ? json({ items: [member()], next_starting_after: "page-two" })
        : json({
            items: [
              member({
                sub_workspace_id: uuidFor(2),
                sub_workspace_name: "New [ACME]  Team",
              }),
              member({
                sub_workspace_id: uuidFor(3),
                sub_workspace_name: "New [acme] Team",
              }),
              member({
                status: "pending",
                sub_workspace_name: "New [acme] Team",
              }),
              member({
                status: "rejected",
                sub_workspace_name: "New [acme] Team",
              }),
            ],
          });
    };
    const result = await listInstantlySubworkspaces(
      { client: fetchStub },
      { search: "  [AcMe]   TEAM  " }
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(
      result.subworkspaces.map((workspace) => workspace.id),
      [uuidFor(2), uuidFor(3)]
    );
    assert.equal(result.totalAcceptedSubworkspaces, 3);
    assert.equal(result.totalMatches, 2);
    assert.equal(result.nextStartingAfter, null);
    assert.deepEqual(result.excludedMemberships, { pending: 1, rejected: 1 });
    const empty = await listInstantlySubworkspaces(
      { client: fetchStub },
      { search: "No such name" }
    );
    assert.deepEqual(empty.subworkspaces, []);
    assert.equal(empty.totalMatches, 0);
    assert.equal(empty.totalAcceptedSubworkspaces, 3);
    assert.equal(empty.membershipComplete, true);
    assert.equal(empty.nextStartingAfter, null);
  });

  it("does not return an early search match when a later membership page is invalid", async () => {
    let calls = 0;
    await assert.rejects(
      listInstantlySubworkspaces(
        {
          client: () => {
            calls += 1;
            return calls === 1
              ? json({ items: [member()], next_starting_after: "later" })
              : json({ items: [member({ admin_workspace_id: uuidFor(1) })] });
          },
        },
        { search: "Rick" }
      ),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
    assert.equal(calls, 2);
  });

  it("bounds pages by bytes and continues without omissions when provider order changes", async () => {
    let calls = 0;
    // Each provider page fits, but the combined selected names do not.
    const records = Array.from({ length: 5 }, (_, index) =>
      member({
        id: uuidFor(index + 1),
        sub_workspace_id: uuidFor(index + 1),
        sub_workspace_name: `Team ${"x".repeat(100_000)}`,
      })
    );
    const fetchStub: ProviderClient = (request) => {
      calls += 1;
      const index = Number(inputOf(request).starting_after ?? "0");
      return json({
        items: [records[index]],
        next_starting_after: index < 4 ? String(index + 1) : null,
      });
    };
    const first = await listInstantlySubworkspaces(
      { client: fetchStub },
      { limit: 100, search: "Team" }
    );
    assert.equal(first.subworkspaces.length, 2);
    assert.equal(first.nextStartingAfter, uuidFor(2));
    records.reverse();
    const second = await listInstantlySubworkspaces(
      { client: fetchStub },
      {
        limit: 100,
        search: "Team",
        startingAfter: first.nextStartingAfter ?? undefined,
      }
    );
    assert.equal(second.nextStartingAfter, uuidFor(4));
    const last = await listInstantlySubworkspaces(
      { client: fetchStub },
      {
        limit: 100,
        search: "Team",
        startingAfter: second.nextStartingAfter ?? undefined,
      }
    );
    assert.equal(last.nextStartingAfter, null);
    assert.equal(calls, 15);
    assert.deepEqual(
      [first, second, last].flatMap((page) =>
        page.subworkspaces.map((workspace) => workspace.id)
      ),
      [1, 2, 3, 4, 5].map(uuidFor)
    );
    for (const page of [first, second, last]) {
      assert.equal(page.totalMatches, 5);
      assert.ok(
        Buffer.byteLength(JSON.stringify(page)) <= MAX_TEST_RESPONSE_BYTES
      );
    }
  });

  it("rejects invalid discovery inputs before fetching membership", async () => {
    let calls = 0;
    const fetchStub: ProviderClient = () => {
      calls += 1;
      return json({ items: [member()] });
    };
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { search: "  " },
      { search: "x".repeat(201) },
      { startingAfter: "not-a-uuid" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential assertions verify each rejected input.
      await assert.rejects(
        listInstantlySubworkspaces({ client: fetchStub }, query),
        (error) => {
          assert.ok(error instanceof InstantlyApiError);
          assert.equal(error.kind, "invalid-input");
          return true;
        }
      );
    }
    assert.equal(calls, 0);
  });

  it("rejects a cursor outside the filtered results instead of silently skipping workspaces", async () => {
    await assert.rejects(
      listInstantlySubworkspaces(
        { client: () => json({ items: [member()] }) },
        { search: "Unmatched", startingAfter: WORKSPACE_ID }
      ),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "invalid-input");
        return true;
      }
    );
  });

  it("rejects duplicate accepted IDs rather than returning an ambiguous continuation cursor", async () => {
    await assert.rejects(
      listInstantlySubworkspaces({
        client: () => json({ items: [member(), member()] }),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  });
});
