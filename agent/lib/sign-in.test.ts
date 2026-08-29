import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationRequiredError,
} from "eve/connections";

// Connector variables the connection modules require at evaluation time.
// Any value satisfies discovery; nothing here is ever contacted.
const example = readFileSync(
  fileURLToPath(new URL("../../.env.example", import.meta.url)),
  "utf8"
);
for (const line of example.split("\n")) {
  const name = /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1];
  if (name) {
    process.env[name] ??= "stub/stub";
  }
}

const [
  { SIGN_IN_CONNECTIONS, signInAuth },
  { default: signIn },
  { SLACK_SIGN_IN_REASON, consentAuth },
  { AUTONOMOUS_PRINCIPAL, UNATTENDED_ATTRIBUTE },
] = await Promise.all([
  import("./sign-in.js"),
  import("../tools/sign_in.js"),
  import("./user-connect.js"),
  import("./trust.js"),
]);

type Execute = typeof signIn.execute;
type Ctx = Parameters<Execute>[1];

const attendedAuth = {
  attributes: {},
  authenticator: "slack",
  principalId: "slack:T123:U456",
  principalType: "user",
} as const;

/** A ctx whose getToken records the providers it was asked for. */
function fakeCtx(
  behavior: (provider: unknown) => Promise<{ token: string }>,
  auth: unknown = attendedAuth
) {
  const requested: unknown[] = [];
  const ctx = {
    getToken: (provider: unknown) => {
      requested.push(provider);
      return behavior(provider);
    },
    session: { auth: { current: auth } },
  } as unknown as Ctx;
  return { ctx, requested };
}

const TS_EXTENSION = /\.ts$/u;

describe("sign_in registry", () => {
  it("covers exactly the user-scoped connections", () => {
    const connectionsRoot = new URL("../connections/", import.meta.url);
    const userScoped = readdirSync(connectionsRoot)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        readFileSync(new URL(name, connectionsRoot), "utf8").includes(
          'from "../lib/user-connect.js"'
        )
      )
      .map((name) => name.replace(TS_EXTENSION, ""))
      .sort();
    assert.deepEqual(SIGN_IN_CONNECTIONS, userScoped);
    for (const name of SIGN_IN_CONNECTIONS) {
      const entry = signInAuth(name);
      assert.ok(entry, `${name} must resolve`);
      assert.equal(entry.consent.principalType, "user");
      assert.equal(consentAuth(entry.wrapped), entry.consent);
    }
  });

  it("resolves nothing for app-scoped or unknown connections", () => {
    assert.equal(signInAuth("intercom"), undefined);
    assert.equal(signInAuth("linear"), undefined);
    assert.equal(signInAuth("not-a-connection"), undefined);
  });
});

describe("sign_in tool", () => {
  it("refuses unattended sessions before requesting any token", async () => {
    const cases = [
      null,
      { attributes: {}, principalId: AUTONOMOUS_PRINCIPAL },
      {
        attributes: { [UNATTENDED_ATTRIBUTE]: "true" },
        principalId: "slack:T123:U0OWNER",
        principalType: "user",
      },
      {
        attributes: {},
        principalId: "acquisity-asks",
        principalType: "service",
      },
    ];
    await Promise.all(
      cases.map(async (auth) => {
        const { ctx, requested } = fakeCtx(() => {
          throw new Error("must not request a token");
        }, auth);
        const result = await signIn.execute({ connection: "stripe" }, ctx);
        assert.deepEqual(result, {
          connected: false,
          error:
            "Sign-in needs a person watching this session; unattended runs cannot complete a consent flow.",
        });
        assert.equal(requested.length, 0);
      })
    );
  });

  it("reports an existing grant without invoking consent", async () => {
    const { ctx, requested } = fakeCtx(() =>
      Promise.resolve({ token: "live-grant" })
    );
    const result = await signIn.execute({ connection: "stripe" }, ctx);
    assert.deepEqual(result, { connected: true });
    assert.equal(requested.length, 1);
    // The token must never reach the model-visible output.
    assert.equal(JSON.stringify(result).includes("live-grant"), false);
  });

  it("invokes consent only for the known Slack-denial error", async () => {
    const { ctx, requested } = fakeCtx(() => {
      if (requested.length === 1) {
        return Promise.reject(
          new ConnectionAuthorizationFailedError("stripe", {
            reason: SLACK_SIGN_IN_REASON,
            retryable: false,
          })
        );
      }
      // The consent probe raises "authorization required"; the real runtime
      // turns it into the parked consent flow, so the tool lets it through.
      return Promise.reject(new ConnectionAuthorizationRequiredError("stripe"));
    });
    await assert.rejects(
      async () => {
        await signIn.execute({ connection: "stripe" }, ctx);
      },
      (error: unknown) => isConnectionAuthorizationRequiredError(error)
    );
    assert.equal(requested.length, 2);
    const entry = signInAuth("stripe");
    assert.ok(entry);
    assert.equal(requested[0], entry.wrapped);
    assert.equal(requested[1], entry.consent);
  });

  it("reports the connection once consent resolves inline", async () => {
    const { ctx, requested } = fakeCtx(() => {
      if (requested.length === 1) {
        return Promise.reject(
          new ConnectionAuthorizationFailedError("stripe", {
            reason: SLACK_SIGN_IN_REASON,
            retryable: false,
          })
        );
      }
      return Promise.resolve({ token: "fresh-grant" });
    });
    const result = await signIn.execute({ connection: "stripe" }, ctx);
    assert.deepEqual(result, { connected: true });
    assert.equal(requested.length, 2);
    assert.equal(JSON.stringify(result).includes("fresh-grant"), false);
  });

  it("propagates unrelated errors without invoking consent", async () => {
    const failures = [
      new ConnectionAuthorizationFailedError("stripe", {
        reason: "access_denied",
        retryable: false,
      }),
      new Error("mcp server unreachable"),
      new ConnectionAuthorizationRequiredError("stripe"),
    ];
    await Promise.all(
      failures.map(async (failure) => {
        const { ctx, requested } = fakeCtx(() => Promise.reject(failure));
        await assert.rejects(
          async () => {
            await signIn.execute({ connection: "stripe" }, ctx);
          },
          (error: unknown) => error === failure
        );
        assert.equal(requested.length, 1);
      })
    );
  });

  it("refuses a connection that does not use per-user sign-in", async () => {
    const { ctx, requested } = fakeCtx(() => {
      throw new Error("must not request a token");
    });
    const result = await signIn.execute(
      { connection: "intercom" } as Parameters<Execute>[0],
      ctx
    );
    assert.deepEqual(result, {
      connected: false,
      error: "intercom does not use per-user sign-in.",
    });
    assert.equal(requested.length, 0);
  });

  it("is discoverable as a root tool source file", () => {
    // `pnpm validate` runs `eve info` over the compiled app; the manifest
    // assertion lives with the suite's single compiler run in critic.test.ts.
    const source = readFileSync(
      fileURLToPath(new URL("../tools/sign_in.ts", import.meta.url)),
      "utf8"
    );
    assert.ok(source.includes("defineTool({"));
    assert.ok(source.includes("signInAuth(connection)"));
  });
});
