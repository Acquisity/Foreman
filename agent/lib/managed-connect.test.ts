import assert from "node:assert/strict";
import test from "node:test";
import { managedConnect } from "./managed-connect.js";

test("managedConnect skips managed provisioning for app tokens", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (input) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      Response.json({ expiresAt: Date.now() + 60_000, token: "test-token" })
    );
  };

  try {
    const auth = managedConnect({
      connectOptions: { vercelToken: "test-oidc-token" },
      connector: "linear/test",
      principalType: "app",
    });
    const result = await auth.getToken({
      connection: { url: "https://mcp.linear.app/mcp" },
      principal: { type: "app" },
    } as Parameters<typeof auth.getToken>[0]);

    assert.equal(result.token, "test-token");
    assert.deepEqual(requests, [
      "https://api.vercel.com/v1/connect/token/linear%2Ftest",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
