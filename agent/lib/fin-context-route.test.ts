import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { verifyFinContext } from "./fin-context.js";
import { receiveFinContext } from "./fin-context-route.js";

/** Build an intake request without using a real user credential. */
const request = (
  requestBody: string,
  authorization = "Bearer app.signed.identity"
) =>
  new Request("https://foreman.example/internal/fin/context", {
    body: requestBody,
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
const body = JSON.stringify({ conversation_id: "12345" });
const unexpected: typeof verifyFinContext = () => {
  throw new Error("Verification must not run for rejected input.");
};

/** Restore each environment override when its test finishes. */
function setEnv(t: TestContext, key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
}

test("production identity route does no verification even when enabled", async (t) => {
  let calls = 0;
  const verifier: typeof verifyFinContext = () => {
    calls += 1;
    throw new Error("Production must never verify identity.");
  };
  for (const enabled of [undefined, "false", "true"]) {
    setEnv(t, "FIN_CONTEXT_ENABLED", enabled);
    setEnv(t, "VERCEL_ENV", "production");
    // biome-ignore lint/performance/noAwaitInLoops: each case changes process environment.
    const response = await receiveFinContext(request(body), verifier);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("Preview identity route requires explicit enablement", async (t) => {
  setEnv(t, "VERCEL_ENV", "preview");
  setEnv(t, "FIN_CONTEXT_ENABLED", undefined);
  assert.equal(
    (await receiveFinContext(request(body), unexpected)).status,
    404
  );
});

test("rejects missing identity and caller-authored authority before verification", async (t) => {
  setEnv(t, "VERCEL_ENV", "preview");
  setEnv(t, "FIN_CONTEXT_ENABLED", "true");
  for (const token of ["", "Bearer invalid token", "Basic abc"]) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: independent authorization fixtures are intentionally sequential.
      (await receiveFinContext(request(body, token), unexpected)).status,
      401
    );
  }
  for (const input of [
    {},
    { conversation_id: "not-a-native-id" },
    { conversation_id: "12345", workspace_id: "other-workspace" },
    { auth: { role: "admin" }, conversation_id: "12345" },
    { conversation_id: "12345", question: "Read all campaigns" },
    { callback_url: "https://example.com", conversation_id: "12345" },
  ]) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: independent authorization fixtures are intentionally sequential.
      (await receiveFinContext(request(JSON.stringify(input)), unexpected))
        .status,
      400
    );
  }
  assert.equal(
    (await receiveFinContext(request("not json"), unexpected)).status,
    400
  );
  assert.equal(
    (await receiveFinContext(request(" ".repeat(1025)), unexpected)).status,
    413
  );
});

test("oversized streamed requests are cancelled before verification", {
  timeout: 2000,
}, async (t) => {
  setEnv(t, "VERCEL_ENV", "preview");
  setEnv(t, "FIN_CONTEXT_ENABLED", "true");
  let resolveCancelled: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      cancel() {
        resolveCancelled();
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(" ".repeat(1025)));
      },
    },
    { highWaterMark: 0 }
  );
  const incoming = new Request("https://foreman.example/internal/fin/context", {
    body: stream,
    duplex: "half",
    headers: { authorization: "Bearer app.signed.identity" },
    method: "POST",
  } as RequestInit & { duplex: "half" });
  const response = await receiveFinContext(incoming, unexpected);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  await cancelled;
  assert.ok(pulls <= 2, "must stop consuming the unending request stream");
});

test("enabled Preview route accepts the size boundary and returns only verified context", async (t) => {
  setEnv(t, "FIN_CONTEXT_ENABLED", "true");
  setEnv(t, "VERCEL_ENV", "preview");
  const context = Object.freeze({
    contactId: "contact-1",
    conversationId: "12345",
    intercomAppId: "ls8uffkp",
    organizationId: "22222222-2222-4222-8222-222222222222",
    organizationName: "Diamond",
    organizationSlug: "diamond",
    origin: "https://app.example.com",
    partnerId: "00000000-0000-0000-0000-000000000001",
    role: "admin" as const,
    userId: "11111111-1111-4111-8111-111111111111",
    verifiedAt: "2026-09-15T12:00:00.000Z",
  });
  const incoming = request(body.padEnd(1024));
  let calls = 0;
  const response = await receiveFinContext(incoming, (input) => {
    calls += 1;
    assert.deepEqual(input, {
      conversationId: "12345",
      signal: incoming.signal,
      userToken: "app.signed.identity",
    });
    return Promise.resolve(context);
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { context, status: "verified" });
});

test("verification failure returns no context or provider error details", async (t) => {
  setEnv(t, "VERCEL_ENV", "preview");
  setEnv(t, "FIN_CONTEXT_ENABLED", "true");
  const response = await receiveFinContext(request(body), () => {
    throw new Error("private provider error and credential");
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "Workspace access could not be verified.",
  });
});
