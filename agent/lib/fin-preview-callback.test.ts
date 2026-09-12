import assert from "node:assert/strict";
import { describe, it } from "node:test";
import channel from "../channels/fin-preview.js";
import { evePackageUrl } from "./eve-dynamic-tools.js";
import {
  deliverFinCallback,
  type FinCallbackState,
  finDiagnosticFailure,
  isFinCallbackUrl,
} from "./fin-preview-callback.js";

// Matches the verified URL shape; the token is synthetic and never used live.
const callbackUrl = `https://api.intercom.io/hooks/procedures/callback/${"a".repeat(488)}`;
const callback = (): FinCallbackState => ({
  answer: "Verified answer. Source: the test workspace billing read.",
  delivered: false,
  url: callbackUrl,
});

// Match the repository's existing Eve context fixtures, without a live run.
const { ContextContainer, contextStorage } = (await import(
  new URL("./dist/src/context/container.js", evePackageUrl()).href
)) as {
  ContextContainer: new () => { set: (key: unknown, value: unknown) => void };
  contextStorage: { run: <T>(store: unknown, body: () => T) => T };
};
const { SessionKey } = (await import(
  new URL("./dist/src/context/keys.js", evePackageUrl()).href
)) as { SessionKey: unknown };
const emit = (
  type:
    | "turn.started"
    | "message.completed"
    | "session.completed"
    | "session.failed",
  data: unknown,
  state: { callback: FinCallbackState | null }
) => {
  const store = new ContextContainer();
  store.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "test-session",
    turn: { id: "test-turn" },
  });
  const handler = (
    channel as unknown as {
      adapter: Record<
        string,
        (event: unknown, context: unknown) => void | Promise<void>
      >;
    }
  ).adapter[type];
  return contextStorage.run(store, () =>
    handler(data, { session: { id: "test-session" }, state })
  );
};

describe("Fin procedure callback", () => {
  it("rejects unverified, redirected, malformed, and local destinations", () => {
    assert.equal(isFinCallbackUrl(callbackUrl), true);
    assert.equal(
      isFinCallbackUrl(
        "https://api.intercom.io/hooks/procedures/callback/a_b-C2"
      ),
      true
    );
    for (const url of [
      "not a URL",
      "http://127.0.0.1/private",
      "https://example.com/report",
      "https://app.intercom.com/a/inbox/ls8uffkp",
      "https://intercom.com.attacker.test/callback",
      "https://intercom.com@attacker.test/callback",
      callbackUrl.replace("https:", "http:"),
      callbackUrl.replace("api.intercom.io", "api.intercom.io:443"),
      callbackUrl.replace("api.intercom.io", "api.intercom.io:8443"),
      callbackUrl.replace("api.intercom.io", "user:secret@api.intercom.io"),
      `${callbackUrl}?`,
      `${callbackUrl}?target=elsewhere`,
      `${callbackUrl}#`,
      `${callbackUrl}#fragment`,
      `${callbackUrl}/more`,
      `${callbackUrl}%2fmore`,
      `${callbackUrl}\n`,
      "https://api.intercom.io/hooks/procedures/callback/",
      `https://api.intercom.io/hooks/procedures/callback/${"x".repeat(1025)}`,
    ]) {
      assert.equal(isFinCallbackUrl(url), false);
    }
  });

  it("does nothing for runs without a callback or an already delivered result", async () => {
    const request: typeof fetch = () =>
      assert.fail("this run must not contact any callback");
    await deliverFinCallback(null, "test-session", "completed", request);
    await deliverFinCallback(
      { ...callback(), delivered: true },
      "test-session",
      "completed",
      request
    );
  });

  it("records only bounded final text and resets it across delegated turns", async () => {
    let state = { callback: callback() };
    await emit("turn.started", {}, state);
    assert.equal(state.callback.answer, "");
    await emit(
      "message.completed",
      { finishReason: "tool-calls", message: "Private intermediate tool text" },
      state
    );
    assert.equal(state.callback.answer, "");
    await emit(
      "message.completed",
      { finishReason: "stop", message: "I delegated the source read." },
      state
    );
    // Eve snapshots adapter state as JSON between native workflow steps.
    state = JSON.parse(JSON.stringify(state));
    await emit("turn.started", {}, state);
    await emit(
      "message.completed",
      { finishReason: "stop", message: "x".repeat(13_000) },
      state
    );
    assert.equal(
      state.callback.answer,
      `${"x".repeat(12_000)}\n[Report truncated.]`
    );
    assert.equal(state.callback.url, callbackUrl);
  });

  it("contains invalid destinations without logging the URL or report", async (context) => {
    const lines: string[] = [];
    context.mock.method(console, "info", (line: string) => lines.push(line));
    const state = { ...callback(), url: "https://attacker.test/private-token" };
    await deliverFinCallback(state, "test-session", "completed", () =>
      assert.fail("invalid callback must not receive the report")
    );
    assert.equal(state.delivered, false);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [
        {
          event: "fin_preview_callback_failed",
          message: "Fin preview callback could not be delivered.",
          sessionId: "test-session",
        },
      ]
    );
  });

  it("delivers the restored native terminal result without any HTTP observer", async (context) => {
    const requests: { url: unknown; init: RequestInit | undefined }[] = [];
    context.mock.method(
      globalThis,
      "fetch",
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ init, url });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    );
    context.mock.method(console, "info", () => undefined);
    const state = JSON.parse(JSON.stringify({ callback: callback() }));
    await emit("session.completed", undefined, state);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, callbackUrl);
    assert.equal(requests[0].init?.redirect, "error");
    assert.equal(requests[0].init?.method, "POST");
    assert.ok(requests[0].init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      message: state.callback.answer,
      status: "completed",
    });
    assert.equal(state.callback.delivered, true);
    await emit("session.completed", undefined, state);
    assert.equal(requests.length, 1);
  });

  it("sends a fixed native failure instead of a partial answer or exception", async (context) => {
    const bodies: unknown[] = [];
    context.mock.method(
      globalThis,
      "fetch",
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    );
    context.mock.method(console, "info", () => undefined);
    await emit(
      "session.failed",
      { message: "private provider exception", sessionId: "failed-session" },
      { callback: callback() }
    );
    await emit("session.completed", undefined, {
      callback: { ...callback(), answer: "" },
    });
    assert.deepEqual(bodies, [finDiagnosticFailure, finDiagnosticFailure]);
  });

  it("aborts stalled delivery using the five-second request deadline", async (context) => {
    const controller = new AbortController();
    context.mock.method(console, "info", () => undefined);
    context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.equal(milliseconds, 5000);
      setTimeout(() => controller.abort(), 1);
      return controller.signal;
    });
    const state = callback();
    await deliverFinCallback(
      state,
      "test-session",
      "completed",
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private timeout")),
            { once: true }
          );
        })
    );
    assert.equal(controller.signal.aborted, true);
    assert.equal(state.delivered, false);
  });

  it("contains rejected or unsuccessful delivery without marking success", async (context) => {
    const lines: string[] = [];
    let attempts = 0;
    context.mock.method(console, "info", (line: string) => lines.push(line));
    await Promise.all(
      [
        () => {
          attempts += 1;
          return Promise.resolve(
            new Response("private response", { status: 503 })
          );
        },
        () => {
          attempts += 1;
          return Promise.reject(new Error("private transport error"));
        },
      ].map(async (request) => {
        const state = callback();
        await deliverFinCallback(state, "test-session", "completed", request);
        assert.equal(state.delivered, false);
      })
    );
    assert.equal(attempts, 2);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => !line.includes("private")));
  });
});
