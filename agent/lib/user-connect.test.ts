import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationFailedError,
} from "eve/connections";
import {
  SLACK_SIGN_IN_REASON,
  slackSignInDenial,
  TASK_MODE_SIGN_IN_REASON,
  userConnect,
  withoutConsent,
} from "./user-connect.js";

test("slackSignInDenial denies every Slack-issued user principal", () => {
  const required = new ConnectionAuthorizationRequiredError("jam");
  const slackPrincipal = { id: "slack:T123:U456", type: "user" } as const;
  const denial = slackSignInDenial(required, slackPrincipal);
  assert.equal(denial?.reason, SLACK_SIGN_IN_REASON);
  assert.equal(denial?.retryable, false);
  assert.equal(denial?.connectionName, "jam");
  assert.equal((denial?.message ?? "").includes("jam"), false);
  assert.equal(
    (denial?.message ?? "").includes("optional evidence source"),
    true
  );

  // The gate reads the principal id, not a session attribute: an intake-only
  // stamp changes nothing, and an unstamped developer-channel mention from
  // the same workspace is denied the same way.
  assert.ok(
    slackSignInDenial(required, {
      ...slackPrincipal,
      attributes: { intakeOnly: "true" },
    })
  );

  // The SLA schedule builds the same Slack principal shape by hand.
  assert.ok(
    slackSignInDenial(required, {
      attributes: { user_id: "U0OWNER" },
      id: "slack:T123:U0OWNER",
      type: "user",
    })
  );
});

test("slackSignInDenial leaves every other principal and error alone", () => {
  const required = new ConnectionAuthorizationRequiredError("jam");

  // Linear Agent Sessions and local eve sessions keep the normal consent
  // flow, as does any app-scoped resolution.
  assert.equal(
    slackSignInDenial(required, { id: "linear:user:1", type: "user" }),
    undefined
  );
  assert.equal(slackSignInDenial(required, { type: "app" }), undefined);

  // An unrelated failure is never rewritten into a sign-in denial.
  assert.equal(
    slackSignInDenial(new Error("mcp server unreachable"), {
      id: "slack:T123:U456",
      type: "user",
    }),
    undefined
  );
});

test("withoutConsent gives a task-mode child the task-mode reason under a Slack session", async () => {
  const inner = userConnect({
    connectOptions: { vercelToken: "test-oidc-token" },
    connector: "sentry/test",
  });
  // What userConnect's own gate throws for a Slack session: already a denial,
  // no longer an "authorization required".
  const gated = slackSignInDenial(
    new ConnectionAuthorizationRequiredError("sentry"),
    {
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
