import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

process.env.INSTANTLY_API_CONNECTOR ??= "api.instantly.ai/acquisity-foreman";
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const [
  { instantlyApiAuth },
  { default: listWorkspaces },
  { default: readWorkspace },
] = await Promise.all([
  import("./instantly-api-auth.js"),
  import("../tools/list_instantly_subworkspaces.js"),
  import("../tools/read_instantly_subworkspace.js"),
]);

describe("Instantly tool authorization", () => {
  it("uses a non-interactive app-scoped connector", () => {
    assert.equal(instantlyApiAuth.principalType, "app");
    assert.equal("startAuthorization" in instantlyApiAuth, false);
  });

  it("denies both tools before requesting a token on an unstamped session", async () => {
    let requestedToken = false;
    const context = {
      getToken: () => {
        requestedToken = true;
        throw new Error("should not request a token");
      },
      session: { auth: { current: null } },
    } as unknown as Parameters<typeof listWorkspaces.execute>[1];

    const listResult = await listWorkspaces.execute({}, context);
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
    assert.equal(requestedToken, false);
  });
});

describe("Instantly tool inputs", () => {
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
