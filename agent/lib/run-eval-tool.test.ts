import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import {
  fakeSandbox,
  ok,
  REPOSITORY,
  type RunOptions,
  type RunResult,
} from "./prepare-repository-fixtures.js";
import { REPOSITORY_MARKER } from "./repository.js";
import { stampTrusted, stampUnattended } from "./trust.js";

const { gatewayPolicy, runEvalTool, runPreparedEval } = await import(
  "../tools/run_eval.js"
);

const WORKTREE = "/workspace/repo";
const SMOKE_COMMAND = `cd '${WORKTREE}' && set -a && . ./.env.example && set +a && AI_GATEWAY_API_KEY=placeholder pnpm eval 'smoke' 2>&1`;
const THREW = /sandbox gone/u;

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
    result = () => ok("smoke ✓ passed\n1 passed, 0 failed"),
  }: {
    prepared?: boolean;
    result?: (options: RunOptions) => Promise<RunResult>;
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
  const original = console.warn;
  console.warn = (line: unknown) => {
    warnings.push(String(line));
  };
  let brokered = 0;
  const context = {
    getSandbox: () => Promise.resolve(sandbox as SandboxSession),
    session: { auth: { current } },
  };
  try {
    const outcome = await runPreparedEval(filter, context, (s) => {
      brokered += 1;
      return s.setNetworkPolicy(gatewayPolicy("real"));
    }).catch((error: unknown) => ({ thrown: error }));
    return { brokered, commands, outcome, policies, warnings };
  } finally {
    console.warn = original;
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
      summary: "smoke ✓ passed\n1 passed, 0 failed",
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
          stdout: "booting\nError: MODEL_CALL_FAILED\nsmoke failed",
        }),
    });

    assert.deepEqual(outcome, {
      exitCode: 1,
      firstError: "Error: MODEL_CALL_FAILED",
      success: false,
      summary: "booting\nError: MODEL_CALL_FAILED\nsmoke failed",
    });
  });

  it("restores the policy when the command throws", async () => {
    const { outcome, policies } = await run("smoke", trusted, {
      result: () => Promise.reject(new Error("sandbox gone")),
    });

    assert.match(String((outcome as { thrown: Error }).thrown), THREW);
    assert.deepEqual(policies, [gatewayPolicy("real"), "allow-all"]);
  });

  type Refusal = [
    string,
    string | undefined,
    SessionAuthContext | null,
    boolean,
  ];
  const refusals: Refusal[] = [
    ["untrusted", "smoke", baseAuth, true],
    ["no auth", "smoke", null, true],
    ["unattended", "smoke", stampUnattended(trusted), true],
    ["shell metacharacters", "smoke; env", trusted, true],
    ["quote", "smoke'", trusted, true],
    ["traversal", "../etc", trusted, true],
    ["no repository prepared", "smoke", trusted, false],
  ];
  for (const [name, filter, auth, prepared] of refusals) {
    it(`refuses ${name} without a credential window`, async () => {
      const { brokered, commands, outcome, policies, warnings } = await run(
        filter,
        auth,
        { prepared }
      );

      assert.equal((outcome as { success: boolean }).success, false);
      assert.equal(brokered, 0);
      assert.deepEqual(commands, []);
      assert.deepEqual(policies, []);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes("\n"), false);
    });
  }

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
