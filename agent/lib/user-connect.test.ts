import assert from "node:assert/strict";
import test from "node:test";
import { userConnect } from "./user-connect.js";

test("userConnect uses an existing connector without managed reprovisioning", async () => {
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
    const auth = userConnect({
      connectOptions: { vercelToken: "test-oidc-token" },
      connector: "sentry/test",
    });
    const result = await auth.getToken({
      connection: { url: "https://mcp.sentry.dev/mcp" },
      principal: { id: "slack:workspace:user", type: "user" },
    } as Parameters<typeof auth.getToken>[0]);

    assert.equal(result.token, "test-token");
    assert.deepEqual(requests, [
      "https://api.vercel.com/v1/connect/token/sentry%2Ftest",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
