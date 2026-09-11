import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { InstantlyApiError } from "./instantly-api.js";

process.env.EXECUTOR_MCP_CONNECTOR ??= "api.instantly.ai/acquisity-foreman";
process.env.LINEAR_CONNECTOR ??= "linear/test";

const [
  { executorAuth },
  { default: listWorkspaces },
  { default: readWorkspace },
] = await Promise.all([
  import("./executor/auth.js"),
  import("../tools/list_instantly_subworkspaces.js"),
  import("../tools/read_instantly_subworkspace.js"),
]);

describe("Instantly tool authorization", () => {
  it("uses a non-interactive app-scoped connector", () => {
    assert.equal(executorAuth().principalType, "app");
    assert.equal("startAuthorization" in executorAuth(), false);
  });

  it("both helpers use shared app access without an investigation stamp", async () => {
    const previous = process.env.EXECUTOR_OPERATION_BINDINGS;
    process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
      "instantly.workspace-group-members": {
        arguments: {},
        path: "instantly.org.test.listMembers",
      },
    });
    let requestedToken = 0;
    const context = {
      abortSignal: new AbortController().signal,
      getToken: () => {
        requestedToken += 1;
        throw new InstantlyApiError("test credential unavailable", {
          kind: "authorization",
        });
      },
      session: { auth: { current: null } },
    } as unknown as Parameters<typeof listWorkspaces.execute>[1];

    try {
      const listResult = await listWorkspaces.execute({}, context);
      const requestsAfterList = requestedToken;
      assert.ok(requestsAfterList > 0);
      const readResult = await readWorkspace.execute(
        {
          limit: 20,
          resource: "accounts",
          workspaceId: "e05cbe7b-67db-4b07-b712-46b9365dc83f",
        },
        context as Parameters<typeof readWorkspace.execute>[1]
      );

      assert.equal((listResult as { available: boolean }).available, false);
      assert.equal((readResult as { available: boolean }).available, false);
      assert.ok(requestedToken > requestsAfterList);
    } finally {
      if (previous === undefined) {
        delete process.env.EXECUTOR_OPERATION_BINDINGS;
      } else {
        process.env.EXECUTOR_OPERATION_BINDINGS = previous;
      }
    }
  });
});

describe("Instantly tool inputs", () => {
  it("publishes an object schema with all three resource branches", () => {
    assert.ok(readWorkspace.inputSchema instanceof z.ZodType);
    const schema = z.toJSONSchema(readWorkspace.inputSchema, {
      io: "input",
      target: "draft-7",
    });
    assert.equal(schema.type, "object");
    assert.equal(schema.oneOf?.length, 3);
  });

  it("allows name discovery without IDs and rejects unbounded or empty searches", () => {
    assert.ok(listWorkspaces.inputSchema instanceof z.ZodType);
    const schema = listWorkspaces.inputSchema;
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(
      schema.safeParse({ limit: 5, search: "New onboarding" }).success,
      true
    );
    assert.equal(schema.safeParse({ search: "   " }).success, false);
    assert.equal(schema.safeParse({ limit: 101 }).success, false);
    assert.equal(schema.safeParse({ startingAfter: "invalid" }).success, false);
  });

  it("requires exactly one workspace selector", () => {
    assert.ok(readWorkspace.inputSchema instanceof z.ZodType);
    const schema = readWorkspace.inputSchema;

    assert.equal(
      schema.safeParse({ limit: 20, resource: "accounts" }).success,
      false
    );
    assert.equal(
      schema.safeParse({
        limit: 20,
        resource: "accounts",
        workspaceId: "e05cbe7b-67db-4b07-b712-46b9365dc83f",
        workspaceName: "Duplicate selector",
      }).success,
      false
    );
    assert.equal(
      schema.safeParse({
        limit: 20,
        resource: "accounts",
        workspaceId: "e05cbe7b-67db-4b07-b712-46b9365dc83f",
      }).success,
      true
    );
  });

  it("offers only the three fixed read resources", () => {
    assert.ok(readWorkspace.inputSchema instanceof z.ZodType);
    assert.equal(
      readWorkspace.inputSchema.safeParse({
        limit: 20,
        resource: "delete_workspace",
        workspaceId: "e05cbe7b-67db-4b07-b712-46b9365dc83f",
      }).success,
      false
    );
  });
});
