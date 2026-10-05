import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext, SessionParent } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import {
  fakeSandbox,
  ok,
  REPOSITORY,
  type RunOptions,
  type RunResult,
} from "./prepare-repository-fixtures.js";
import { REPOSITORY_MARKER, stampRepository } from "./repository.js";
import { stampTrusted, stampUnattended } from "./trust.js";

const { gatewayPolicy, runEvalTool, runPreparedEval } = await import(
  "../tools/run_eval.js"
);

const WORKTREE = "/workspace/repo";
const SMOKE_COMMAND = `cd '${WORKTREE}' && timeout -k 10s 570s bash -c 'set -a; . ./.env.example; set +a; AI_GATEWAY_API_KEY=placeholder pnpm --silent eval --json "$@"' run_eval 'smoke'`;
const THREW = /sandbox gone/u;
const WINDOW_FAILED = /gateway token unavailable/u;
const SMOKE_REPORT = JSON.stringify({
  failed: 0,
  passed: 1,
  results: [{ assertions: [], id: "smoke", verdict: "passed" }],
  scored: 0,
  skipped: 0,
});

const baseAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};
const trusted = stampTrusted(baseAuth);

const run = async (
  filter: string | undefined,
  current: SessionAuthContext | null,
  {
    prepared = true,
    result = () => ok(SMOKE_REPORT),
    parent,
    resetFailures = 0,
    brokerFails = false,
  }: {
    brokerFails?: boolean;
    prepared?: boolean;
    result?: (options: RunOptions) => Promise<RunResult>;
    parent?: SessionParent;
    resetFailures?: number;
  } = {}
) => {
  const { commands, policies, sandbox } = fakeSandbox(result);
  Object.assign(sandbox, {
    readTextFile: ({ path }: { path: string }) =>
      Promise.resolve(
        prepared && path === REPOSITORY_MARKER
          ? JSON.stringify({
              slug: REPOSITORY,
              source: "explicit",
              worktree: WORKTREE,
            })
          : null
      ),
  });
  const warnings: string[] = [];
  const errors: string[] = [];
  const original = console.warn;
  const originalError = console.error;
  console.warn = (line: unknown) => {
    warnings.push(String(line));
  };
  console.error = (line: unknown) => {
    errors.push(String(line));
  };
  const setPolicy = sandbox.setNetworkPolicy;
  let resets = 0;
  sandbox.setNetworkPolicy = async (policy) => {
    await setPolicy(policy);
    if (policy === "allow-all") {
      resets += 1;
      if (resets <= resetFailures) {
        throw new Error("policy reset failed");
      }
    }
  };
  let brokered = 0;
  const context = {
    getSandbox: () => Promise.resolve(sandbox as SandboxSession),
    session: { auth: { current }, parent },
  };
  try {
    const outcome = await runPreparedEval(filter, context, (s) => {
      brokered += 1;
      return brokerFails
        ? Promise.reject(new Error("gateway token unavailable"))
        : s.setNetworkPolicy(gatewayPolicy("real"));
    }).catch((error: unknown) => ({ thrown: error }));
    return { brokered, commands, errors, outcome, policies, warnings };
  } finally {
    console.warn = original;
    console.error = originalError;
  }
};

describe("run_eval", () => {
  it("runs the filtered eval with a placeholder key and restores the policy", async () => {
    const { brokered, commands, outcome, policies, warnings } = await run(
      "smoke",
      trusted
    );

    assert.deepEqual(outcome, {
      exitCode: 0,
      firstError: null,
      success: true,
      summary:
        "smoke: passed\nResults: 1 passed, 0 failed, 0 scored, 0 skipped (1 total)",
    });
    assert.deepEqual(
      commands.map((options) => options.command),
      [SMOKE_COMMAND]
    );
    assert.equal(brokered, 1);
    assert.deepEqual(policies, [gatewayPolicy("real"), "allow-all"]);
    assert.deepEqual(warnings, []);
  });

  it("reports a failing run with its first error", async () => {
    const { outcome } = await run("smoke", trusted, {
      result: () =>
        Promise.resolve({
          exitCode: 1,
          stderr: "",
          stdout: JSON.stringify({
            failed: 1,
            passed: 0,
            results: [
              {
                assertions: [],
                error: "MODEL_CALL_FAILED",
                id: "smoke",
                verdict: "failed",
              },
            ],
            scored: 0,
            skipped: 0,
          }),
        }),
    });

    assert.deepEqual(outcome, {
      exitCode: 1,
      firstError: "MODEL_CALL_FAILED",
      success: false,
      summary:
        "smoke: failed\nResults: 0 passed, 1 failed, 0 scored, 0 skipped (1 total)",
    });
  });

  it("restores the policy when the command throws", async () => {
    const { outcome, policies } = await run("smoke", trusted, {
      result: () => Promise.reject(new Error("sandbox gone")),
    });

    assert.match(String((outcome as { thrown: Error }).thrown), THREW);
    assert.deepEqual(policies, [gatewayPolicy("real"), "allow-all"]);
  });

  it("retries a rejected policy reset once", async () => {
    const { errors, outcome, policies } = await run("smoke", trusted, {
      resetFailures: 1,
    });
    assert.equal((outcome as { success: boolean }).success, true);
    assert.deepEqual(policies, [
      gatewayPolicy("real"),
      "allow-all",
      "allow-all",
    ]);
    assert.deepEqual(errors, []);
  });

  it("logs one bounded error and throws when both policy resets fail", async () => {
    const { errors, outcome, policies } = await run("smoke", trusted, {
      resetFailures: 2,
    });
    assert.equal(
      String((outcome as { thrown: Error }).thrown),
      "Error: policy reset failed"
    );
    assert.deepEqual(policies, [
      gatewayPolicy("real"),
      "allow-all",
      "allow-all",
    ]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("ai-gateway.vercel.sh"));
    assert.ok(errors[0].includes("gateway_transform_stuck"));
    assert.equal(errors[0].includes("\n"), false);
    assert.ok(errors[0].length <= 4000);
  });

  it("refuses child sessions without opening a credential window", async () => {
    const { brokered, commands, outcome, policies, warnings } = await run(
      "smoke",
      trusted,
      {
        parent: {
          callId: "agent-call",
          rootSessionId: "root",
          sessionId: "root",
          turn: { id: "parent-turn", sequence: 1 },
        },
      }
    );
    assert.deepEqual(outcome, {
      error: "Only the root session may run evals.",
      success: false,
    });
    assert.equal(brokered, 0);
    assert.deepEqual(commands, []);
    assert.deepEqual(policies, []);
    assert.equal(warnings.length, 1);
  });

  it("restores the policy after the shell timeout", async () => {
    const { outcome, policies } = await run("smoke", trusted, {
      result: () => Promise.resolve({ exitCode: 124, stderr: "", stdout: "" }),
    });
    assert.deepEqual(outcome, {
      exitCode: 124,
      firstError: "Eval command exceeded its shell timeout.",
      success: false,
      summary: "Eval command exceeded its shell timeout.",
    });
    assert.deepEqual(policies, [gatewayPolicy("real"), "allow-all"]);
  });

  type Refusal = [
    string,
    string | undefined,
    SessionAuthContext | null,
    boolean,
    string,
  ];
  const refusals: Refusal[] = [
    ["untrusted", "smoke", baseAuth, true, "limited to trusted callers"],
    ["no auth", "smoke", null, true, "limited to trusted callers"],
    ["unattended", "smoke", stampUnattended(trusted), true, "Unattended runs"],
    [
      "shell metacharacters",
      "smoke; env",
      trusted,
      true,
      "not a valid eval filter",
    ],
    ["quote", "smoke'", trusted, true, "not a valid eval filter"],
    ["traversal", "../etc", trusted, true, "not a valid eval filter"],
    [
      "no repository prepared",
      "smoke",
      trusted,
      false,
      "No repository has been prepared",
    ],
    [
      "a signed session bound to another repository",
      "smoke",
      stampRepository(trusted, "Acquisity/Other", "github-webhook"),
      true,
      "is bound to Acquisity/Other",
    ],
  ];
  for (const [name, filter, auth, prepared, reason] of refusals) {
    it(`refuses ${name} without a credential window`, async () => {
      const { brokered, commands, outcome, policies, warnings } = await run(
        filter,
        auth,
        { prepared }
      );

      assert.equal((outcome as { success: boolean }).success, false);
      assert.ok((outcome as { error: string }).error.includes(reason));
      assert.equal(brokered, 0);
      assert.deepEqual(commands, []);
      assert.deepEqual(policies, []);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes("\n"), false);
    });
  }

  it("restores the policy and rethrows when opening the window fails", async () => {
    const { commands, outcome, policies } = await run("smoke", trusted, {
      brokerFails: true,
    });
    assert.match(String((outcome as { thrown: Error }).thrown), WINDOW_FAILED);
    assert.deepEqual(commands, []);
    assert.deepEqual(policies, ["allow-all"]);
  });

  it("validates the input schema", () => {
    const schema = runEvalTool.inputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    assert.ok(schema.safeParse({}).success);
    assert.ok(schema.safeParse({ filter: "smoke" }).success);
    assert.ok(!schema.safeParse({ filter: "" }).success);
    assert.ok(!schema.safeParse({ filter: "x".repeat(129) }).success);
  });
});
