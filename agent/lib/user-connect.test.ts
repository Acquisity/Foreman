import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationFailedError,
} from "eve/connections";
import { INTAKE_ONLY_ATTRIBUTE } from "./trust.js";
import {
  intakeOnlySignInDenial,
  TASK_MODE_SIGN_IN_REASON,
  userConnect,
  withoutConsent,
} from "./user-connect.js";

test("withoutConsent gives a task-mode child the task-mode reason under an intake-only session", async () => {
  const inner = userConnect({
    connectOptions: { vercelToken: "test-oidc-token" },
    connector: "sentry/test",
  });
  // What userConnect's own gate throws when the dispatching session is
  // intake-only: already a denial, no longer an "authorization required".
  const gated = intakeOnlySignInDenial(
    new ConnectionAuthorizationRequiredError("sentry"),
    {
      attributes: { [INTAKE_ONLY_ATTRIBUTE]: "true" },
      id: "slack:workspace:user",
      type: "user",
    }
  );
  assert.ok(gated);
  const auth = withoutConsent({
    ...inner,
    getToken: () => Promise.reject(gated),
  });
  await assert.rejects(
    auth.getToken({
      connection: { url: "https://mcp.sentry.dev/mcp" },
      principal: { id: "slack:workspace:user", type: "user" },
    } as Parameters<typeof auth.getToken>[0]),
    (error: unknown) =>
      isConnectionAuthorizationFailedError(error) &&
      error.reason === TASK_MODE_SIGN_IN_REASON &&
      error.retryable === false
  );
});

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

test("withoutConsent turns a sign-in prompt into a terminal failure", async () => {
  const inner = userConnect({
    connectOptions: { vercelToken: "test-oidc-token" },
    connector: "sentry/test",
  });
  const auth = withoutConsent({
    ...inner,
    getToken: () =>
      Promise.reject(new ConnectionAuthorizationRequiredError("sentry")),
  });
  assert.equal((auth as { evict?: unknown }).evict, inner.evict);
  assert.equal(auth.principalType, inner.principalType);
  await assert.rejects(
    auth.getToken({
      connection: { url: "https://mcp.sentry.dev/mcp" },
      principal: { id: "slack:workspace:user", type: "user" },
    } as Parameters<typeof auth.getToken>[0]),
    (error: unknown) =>
      isConnectionAuthorizationFailedError(error) &&
      error.reason === TASK_MODE_SIGN_IN_REASON &&
      error.retryable === false
  );
});

test("withoutConsent passes a resolved token through untouched", async () => {
  const inner = userConnect({
    connectOptions: { vercelToken: "test-oidc-token" },
    connector: "sentry/test",
  });
  const auth = withoutConsent({
    ...inner,
    getToken: () =>
      Promise.resolve({ expiresAt: Date.now() + 60_000, token: "t" }),
  });
  const result = await auth.getToken({
    connection: { url: "https://mcp.sentry.dev/mcp" },
    principal: { id: "slack:workspace:user", type: "user" },
  } as Parameters<typeof auth.getToken>[0]);
  assert.equal(result.token, "t");
});
