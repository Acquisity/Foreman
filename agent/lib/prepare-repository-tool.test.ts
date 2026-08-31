import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const {
  cloneExplicitRepository,
  REPOSITORY_OPERATION_TIMEOUT_MS,
  refreshCheckout,
} = await import("../tools/prepare_repository.js");

const REPOSITORY = "Acquisity/Foreman";
const DISCARD = "rm -rf /workspace/repo";
const TIMEOUT_MS = 20;
const TIMED_OUT = /timed out after 20ms/u;
const CLONE_FAILED = /repository not found/u;
const CLONE_THREW = /sandbox gone/u;
const REFRESH_FAILED = /could not read/u;
const INSTALL_FAILED = /ERR_PNPM_OUTDATED_LOCKFILE/u;

interface RunOptions {
  abortSignal?: AbortSignal;
  command: string;
}

interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const ok = (stdout = ""): Promise<RunResult> =>
  Promise.resolve({ exitCode: 0, stderr: "", stdout });

const failed = (stderr: string): Promise<RunResult> =>
  Promise.resolve({ exitCode: 1, stderr, stdout: "" });

/** Never settles until the caller's deadline aborts it. */
const stall = (options: RunOptions): Promise<RunResult> =>
  new Promise((_resolve, reject) => {
    options.abortSignal?.addEventListener("abort", () => {
      reject(options.abortSignal?.reason);
    });
  });

const fakeSandbox = (run: (options: RunOptions) => Promise<RunResult>) => {
  const commands: RunOptions[] = [];
  const policies: SandboxNetworkPolicy[] = [];
  const sandbox = {
    run: (options: RunOptions) => {
      commands.push(options);
      return run(options);
    },
    setNetworkPolicy: (policy: SandboxNetworkPolicy) => {
      policies.push(policy);
      return Promise.resolve();
    },
  } as unknown as SandboxSession;
  return { commands, policies, sandbox };
};

// Stands in for the brokered GitHub token so the tests never mint one; the
// firewall write is what the `finally` has to undo.
const broker = (sandbox: SandboxSession) =>
  sandbox.setNetworkPolicy({ allow: { "*": [] } });

const ran = (commands: RunOptions[], needle: string) =>
  commands.some((options) => options.command.includes(needle));

describe("prepare_repository sandbox bounds", () => {
  it("bounds every repository operation at five minutes", () => {
    assert.equal(REPOSITORY_OPERATION_TIMEOUT_MS, 300_000);
  });

  it("passes an unaborted deadline signal to the clone by default", async () => {
    const { commands, sandbox } = fakeSandbox(() => ok());
    const error = await cloneExplicitRepository(sandbox, REPOSITORY, {
      broker,
    });
    assert.equal(error, null);
    const clone = commands[0]?.abortSignal;
    assert.ok(clone instanceof AbortSignal);
    assert.equal(clone.aborted, false);
  });

  it("stops a stalled clone, discards the partial checkout, and drops the credential", async () => {
    const { commands, policies, sandbox } = fakeSandbox((options) =>
      options.command.startsWith("git clone") ? stall(options) : ok()
    );
    const error = await cloneExplicitRepository(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", TIMED_OUT);
    assert.ok(ran(commands, DISCARD));
    assert.equal(policies.at(-1), "allow-all");
  });

  it("discards the partial checkout when the clone fails", async () => {
    const { commands, policies, sandbox } = fakeSandbox((options) =>
      options.command.startsWith("git clone")
        ? failed("fatal: repository not found")
        : ok()
    );
    const error = await cloneExplicitRepository(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", CLONE_FAILED);
    assert.ok(ran(commands, DISCARD));
    assert.equal(policies.at(-1), "allow-all");
  });

  it("discards the checkout when the clone throws", async () => {
    const { commands, policies, sandbox } = fakeSandbox((options) =>
      options.command.startsWith("git clone")
        ? Promise.reject(new Error("sandbox gone"))
        : ok()
    );
    await assert.rejects(
      cloneExplicitRepository(sandbox, REPOSITORY, {
        broker,
        timeoutMs: TIMEOUT_MS,
      }),
      CLONE_THREW
    );
    assert.ok(ran(commands, DISCARD));
    assert.equal(policies.at(-1), "allow-all");
  });

  it("keeps a successful clone and still drops the credential", async () => {
    const { commands, policies, sandbox } = fakeSandbox(() => ok());
    assert.equal(
      await cloneExplicitRepository(sandbox, REPOSITORY, {
        broker,
        timeoutMs: TIMEOUT_MS,
      }),
      null
    );
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(policies.at(-1), "allow-all");
  });

  it("stops a stalled fetch/reset, discards the checkout, and drops the credential", async () => {
    const { commands, policies, sandbox } = fakeSandbox((options) =>
      options.command.includes("fetch") ? stall(options) : ok("sha")
    );
    const error = await refreshCheckout(sandbox, REPOSITORY, null, false, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", TIMED_OUT);
    assert.ok(ran(commands, DISCARD));
    assert.equal(policies.at(-1), "allow-all");
  });

  it("discards the checkout when the fetch/reset fails", async () => {
    const { commands, policies, sandbox } = fakeSandbox((options) =>
      options.command.includes("fetch") ? failed("could not read") : ok("sha")
    );
    const error = await refreshCheckout(sandbox, REPOSITORY, null, false, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFRESH_FAILED);
    assert.ok(ran(commands, DISCARD));
    assert.equal(policies.at(-1), "allow-all");
  });

  it("stops a stalled install and discards the checkout", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("pnpm install") ? stall(options) : ok("sha")
    );
    const error = await refreshCheckout(
      sandbox,
      REPOSITORY,
      { kind: "pnpm", slug: REPOSITORY },
      true,
      { broker, timeoutMs: TIMEOUT_MS }
    );
    assert.match(error ?? "", TIMED_OUT);
    assert.ok(ran(commands, DISCARD));
  });

  it("discards the checkout when the install fails", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("pnpm install")
        ? failed("ERR_PNPM_OUTDATED_LOCKFILE")
        : ok("sha")
    );
    const error = await refreshCheckout(
      sandbox,
      REPOSITORY,
      { kind: "pnpm", slug: REPOSITORY },
      true,
      { broker, timeoutMs: TIMEOUT_MS }
    );
    assert.match(error ?? "", INSTALL_FAILED);
    assert.ok(ran(commands, DISCARD));
  });

  it("keeps an unchanged checkout that needs no install", async () => {
    const { commands, policies, sandbox } = fakeSandbox(() => ok("sha"));
    assert.equal(
      await refreshCheckout(
        sandbox,
        REPOSITORY,
        { kind: "pnpm", slug: REPOSITORY },
        false,
        { broker, timeoutMs: TIMEOUT_MS }
      ),
      null
    );
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(ran(commands, "pnpm install"), false);
    assert.equal(policies.at(-1), "allow-all");
  });
});
