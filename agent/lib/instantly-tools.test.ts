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
  it("publishes a flat object schema and retains resource-specific validation", () => {
    assert.ok(readWorkspace.inputSchema instanceof z.ZodType);
    const schema = z.toJSONSchema(readWorkspace.inputSchema, {
      io: "input",
      target: "draft-7",
    });
    assert.equal(schema.type, "object");
    assert.equal(schema.anyOf, undefined);
    assert.equal(schema.oneOf, undefined);
    assert.equal(schema.allOf, undefined);
    const workspaceId = "e05cbe7b-67db-4b07-b712-46b9365dc83f";
    assert.equal(
      readWorkspace.inputSchema.safeParse({
        resource: "accounts",
        status: 0,
        workspaceId,
      }).success,
      false
    );
    assert.deepEqual(
      readWorkspace.inputSchema.parse({
        resource: "campaigns",
        status: 0,
        workspaceId,
      }),
      { limit: 20, resource: "campaigns", status: 0, workspaceId }
    );
    const accountFilters = {
      providerCode: 1,
      resource: "accounts",
      status: 1,
      workspaceId,
    };
    assert.deepEqual(readWorkspace.inputSchema.parse(accountFilters), {
      ...accountFilters,
      limit: 20,
    });
    const emailFilters = {
      campaignId: workspaceId,
      emailAccount: "sender@example.test",
      emailType: "received",
      latestOfThread: true,
      lead: "lead@example.test",
      maxTimestampCreated: "2026-09-11T12:00:00Z",
      minTimestampCreated: "2026-09-10T12:00:00Z",
      resource: "emails",
      workspaceId,
    };
    assert.deepEqual(readWorkspace.inputSchema.parse(emailFilters), {
      ...emailFilters,
      limit: 20,
    });
  });

  it("rejects filters that do not apply to the selected resource", () => {
    assert.ok(readWorkspace.inputSchema instanceof z.ZodType);
    const workspaceId = "e05cbe7b-67db-4b07-b712-46b9365dc83f";
    const emailFilters = {
      campaignId: workspaceId,
      emailAccount: "sender@example.test",
      emailType: "received",
      latestOfThread: true,
      lead: "lead@example.test",
      maxTimestampCreated: "2026-09-11T12:00:00Z",
      minTimestampCreated: "2026-09-10T12:00:00Z",
    };
    for (const resource of ["accounts", "campaigns"]) {
      for (const [field, value] of Object.entries(emailFilters)) {
        assert.equal(
          readWorkspace.inputSchema.safeParse({
            [field]: value,
            resource,
            workspaceId,
          }).success,
          false,
          `${resource} must reject the email filter ${field}`
        );
      }
    }
    for (const resource of ["campaigns", "emails"]) {
      assert.equal(
        readWorkspace.inputSchema.safeParse({
          providerCode: 1,
          resource,
          workspaceId,
        }).success,
        false,
        `${resource} must reject the accounts filter providerCode`
      );
    }
    assert.equal(
      readWorkspace.inputSchema.safeParse({
        resource: "emails",
        status: 1,
        workspaceId,
      }).success,
      false
    );
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
