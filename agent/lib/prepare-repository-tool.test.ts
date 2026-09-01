import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { remoteUrl } from "./repository.js";
import { REPOSITORY_OPERATION_TIMEOUT_MS } from "./sandbox-deadline.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { cloneExplicitRepository, prepareWarmedOrClone, refreshCheckout } =
  await import("../tools/prepare_repository.js");

const REPOSITORY = "Acquisity/Foreman";
const DISCARD = "rm -rf /workspace/repo";
const STAGING = "/workspace/.repo-staging";
const DISCARD_STAGING = `rm -rf ${STAGING}`;
const PUBLISH = `mv ${STAGING} /workspace/repo`;
const TIMEOUT_MS = 20;
const TIMED_OUT = /timed out after 20ms/u;
const CLONE_FAILED = /repository not found/u;
const CLONE_THREW = /sandbox gone/u;
const REFRESH_FAILED = /could not read/u;
const INSTALL_FAILED = /ERR_PNPM_OUTDATED_LOCKFILE/u;
const CANCELLED = /turn cancelled/u;
const REFUSED = /refusing to overwrite/u;
const OTHER_ORIGIN = "https://github.com/Acquisity/Other.git";
const PUBLISH_FAILED = /cross-device link/u;

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

/**
 * Models eve 0.44's `bindSandboxAbortSignal`: the session returned by
 * `ctx.getSandbox()` composes the turn's abort signal into every call, so once
 * the turn is cancelled every later command, the cleanup included, rejects
 * before it starts.
 */
const cancelledSandbox = () => {
  const turn = AbortSignal.abort(new Error("turn cancelled"));
  return fakeSandbox((options) => {
    const composed = options.abortSignal
      ? AbortSignal.any([turn, options.abortSignal])
      : turn;
    return composed.aborted ? Promise.reject(composed.reason) : ok();
  });
};

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
    const clone = commands.find((options) =>
      options.command.startsWith("git clone")
    )?.abortSignal;
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
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.equal(ran(commands, DISCARD), false);
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
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.equal(ran(commands, DISCARD), false);
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
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(policies.at(-1), "allow-all");
  });

  it("clones to the staging path and publishes it by rename", async () => {
    const { commands, policies, sandbox } = fakeSandbox(() => ok());
    assert.equal(
      await cloneExplicitRepository(sandbox, REPOSITORY, {
        broker,
        timeoutMs: TIMEOUT_MS,
      }),
      null
    );
    assert.ok(
      ran(commands, `git clone --depth 50 ${remoteUrl(REPOSITORY)} ${STAGING}`)
    );
    assert.ok(ran(commands, PUBLISH));
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(policies.at(-1), "allow-all");
  });

  it("discards only the staging path when the publishing rename fails", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command === PUBLISH ? failed("mv: cross-device link") : ok()
    );
    const error = await cloneExplicitRepository(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", PUBLISH_FAILED);
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.equal(ran(commands, DISCARD), false);
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

  it("stops a stalled current-revision probe before refreshing", async () => {
    const { commands, policies, sandbox } = fakeSandbox((options) =>
      options.command.includes("rev-parse HEAD") ? stall(options) : ok()
    );
    const error = await refreshCheckout(sandbox, REPOSITORY, null, false, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", TIMED_OUT);
    assert.equal(ran(commands, "fetch"), false);
    assert.ok(ran(commands, DISCARD));
    assert.equal(policies.at(-1), "allow-all");
  });

  it("rejects a failed refreshed-revision probe", async () => {
    let revisionProbes = 0;
    const { commands, policies, sandbox } = fakeSandbox((options) => {
      if (options.command.includes("rev-parse HEAD")) {
        revisionProbes += 1;
        return revisionProbes === 2 ? failed("could not read") : ok("sha");
      }
      return ok();
    });
    const error = await refreshCheckout(sandbox, REPOSITORY, null, false, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFRESH_FAILED);
    assert.ok(ran(commands, "fetch"));
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

  it("propagates a turn cancellation instead of reporting a timeout", async () => {
    const { commands, policies, sandbox } = cancelledSandbox();
    await assert.rejects(
      cloneExplicitRepository(sandbox, REPOSITORY, {
        broker,
        timeoutMs: TIMEOUT_MS,
      }),
      CANCELLED
    );
    // The cleanup is attempted and cannot run: the bound session aborts it, so
    // the partial clone survives at the staging path for the next attempt to
    // clear. `/workspace/repo` is never created, so it is never removed either.
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(policies.at(-1), "allow-all");
  });

  it("reclaims a clone a cancelled turn left unfinished at the staging path", async () => {
    // `/workspace/repo` is absent (the earlier turn never got to publish it) and
    // only the staging path holds debris, which this attempt clears by name.
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.startsWith("test ") ? failed("") : ok()
    );
    assert.equal(
      await prepareWarmedOrClone(sandbox, REPOSITORY, {
        broker,
        timeoutMs: TIMEOUT_MS,
      }),
      null
    );
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.ok(
      ran(commands, `git clone --depth 50 ${remoteUrl(REPOSITORY)} ${STAGING}`)
    );
    assert.ok(ran(commands, PUBLISH));
    assert.equal(ran(commands, DISCARD), false);
  });

  it("stops a stalled warmed-checkout move", async () => {
    const { commands, sandbox } = fakeSandbox((options) => {
      if (options.command === "test -e /workspace/repo") {
        return failed("");
      }
      return options.command.includes(`mv ${STAGING} /workspace/repo`)
        ? stall(options)
        : ok();
    });
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", TIMED_OUT);
    const move = commands.find((options) =>
      options.command.includes(`mv ${STAGING} /workspace/repo`)
    );
    assert.ok(move?.abortSignal instanceof AbortSignal);
    assert.ok(commands.some((options) => options.command === DISCARD_STAGING));
    assert.equal(ran(commands, DISCARD), false);
  });

  it("refuses an occupied checkout that has no configured origin", async () => {
    // `git config --get` exits non-zero for a key that is simply absent, so an
    // unrelated local checkout is indistinguishable from debris and must not be
    // deleted on that inference.
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("remote.origin.url") ? failed("") : ok()
    );
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFUSED);
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(ran(commands, "git clone"), false);
  });

  it("refuses an occupied checkout whose config cannot be read", async () => {
    // The same non-zero exit, this time because `.git/config` is unreadable, so
    // the intended checkout is not destroyed by a transient read failure.
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("remote.origin.url")
        ? failed("fatal: unable to read config file")
        : ok()
    );
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFUSED);
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(ran(commands, "git clone"), false);
  });

  it("adopts an occupied checkout whose origin names this repository", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("remote.origin.url")
        ? ok(remoteUrl(REPOSITORY))
        : ok("sha")
    );
    assert.equal(
      await prepareWarmedOrClone(sandbox, REPOSITORY, {
        broker,
        timeoutMs: TIMEOUT_MS,
      }),
      null
    );
    assert.ok(ran(commands, "fetch"));
    assert.equal(ran(commands, DISCARD), false);
  });

  it("keeps an adopted checkout when its refresh fails", async () => {
    const { commands, sandbox } = fakeSandbox((options) => {
      if (options.command.includes("remote.origin.url")) {
        return ok(remoteUrl(REPOSITORY));
      }
      return options.command.includes("fetch")
        ? failed("could not read")
        : ok("sha");
    });
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFRESH_FAILED);
    assert.equal(ran(commands, DISCARD), false);
  });

  it("keeps an adopted checkout when its install fails", async () => {
    const { commands, sandbox } = fakeSandbox((options) => {
      if (options.command.includes("remote.origin.url")) {
        return ok(remoteUrl(REPOSITORY));
      }
      return options.command.includes("pnpm install")
        ? failed("ERR_PNPM_OUTDATED_LOCKFILE")
        : ok("sha");
    });
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", INSTALL_FAILED);
    assert.equal(ran(commands, DISCARD), false);
  });

  it("still refuses a checkout of a different repository", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("remote.origin.url") ? ok(OTHER_ORIGIN) : ok()
    );
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFUSED);
    assert.equal(ran(commands, DISCARD), false);
    assert.equal(ran(commands, "git clone"), false);
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
