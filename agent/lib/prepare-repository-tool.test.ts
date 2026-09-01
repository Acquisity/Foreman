import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { REPOSITORY_MARKER, remoteUrl, stampRepository } from "./repository.js";
import { REPOSITORY_OPERATION_TIMEOUT_MS } from "./sandbox-deadline.js";
import { stampUnattended } from "./trust.js";

// The commit identity resolves from the environment, so a switch never reaches
// the connector metadata call a Connect runtime would have to serve.
process.env.FOREMAN_BOT_NAME ??= "Foreman";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const {
  cloneExplicitRepository,
  detectWorktree,
  prepareRepositoryWorkspace,
  prepareWarmedOrClone,
  refreshCheckout,
} = await import("../tools/prepare_repository.js");

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
const PROBE_TIMED_OUT = /Could not tell whether a checkout is already present/u;
const WARM_PROBE_TIMED_OUT =
  /Could not determine whether the warmed checkout exists/u;

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

  it("fails closed when the workspace repository probe reaches its deadline", async () => {
    const { sandbox } = fakeSandbox(stall);
    assert.equal(await detectWorktree(sandbox, TIMEOUT_MS), null);
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

  it("refuses to clone when the warmed-checkout probe reaches its deadline", async () => {
    const { commands, sandbox } = fakeSandbox((options) => {
      if (options.command === "test -e /workspace/repo") {
        return failed("");
      }
      return options.command.startsWith("test -d ") ? stall(options) : ok();
    });
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", WARM_PROBE_TIMED_OUT);
    assert.equal(ran(commands, "git clone"), false);
    assert.equal(ran(commands, PUBLISH), false);
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

  it("bounds the occupied checkout origin probe with the caller's deadline", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command.includes("remote.origin.url") ? stall(options) : ok()
    );
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", REFUSED);
    const origin = commands.find((options) =>
      options.command.includes("remote.origin.url")
    );
    assert.ok(origin?.abortSignal instanceof AbortSignal);
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

  it("refuses rather than publishing over a checkout it could not probe", async () => {
    const { commands, sandbox } = fakeSandbox((options) =>
      options.command === "test -e /workspace/repo" ? stall(options) : ok()
    );
    const error = await prepareWarmedOrClone(sandbox, REPOSITORY, {
      broker,
      timeoutMs: TIMEOUT_MS,
    });
    assert.match(error ?? "", PROBE_TIMED_OUT);
    assert.equal(ran(commands, "git clone"), false);
    assert.equal(ran(commands, PUBLISH), false);
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

const OTHER = "Acquisity/Other";
const PREVIOUS = "/workspace/.repo-previous";
const SET_ASIDE = `rm -rf ${PREVIOUS} && mv /workspace/repo ${PREVIOUS}`;
const RESTORE = `rm -rf /workspace/repo && mv ${PREVIOUS} /workspace/repo`;
const DISCARD_PREVIOUS = `rm -rf ${PREVIOUS}`;
const DISCARD_MARKER = `rm -rf ${REPOSITORY_MARKER}`;
const LOCKFILE_DIFF = "diff --name-only";
const HEAD_BEFORE = "1111111111111111111111111111111111111111";
const HEAD_AFTER = "2222222222222222222222222222222222222222";
const SIGNED_REFUSAL = /signed GitHub session is bound/u;
const UNATTENDED_REFUSAL = /unattended session already prepared/u;
const WORKSPACE_REFUSAL = /session workspace itself/u;
const PREVIOUS_KEPT = /Acquisity\/Foreman is still in place/u;
const PREVIOUS_LOST = /could not be restored/u;
const MARKED_OTHER = /Acquisity\/Other/u;

const attendedAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

/**
 * A sandbox holding a repository marker, so the tool sees a session that has
 * already prepared something. The marker write is captured rather than
 * performed: what matters is which repository the session ends up recording.
 */
const preparedSandbox = (
  marker: unknown,
  run: (options: RunOptions) => Promise<RunResult>
) => {
  const commands: RunOptions[] = [];
  const written: string[] = [];
  const sandbox = {
    readTextFile: ({ path }: { path: string }) =>
      Promise.resolve(
        path === REPOSITORY_MARKER && marker !== null
          ? JSON.stringify(marker)
          : null
      ),
    run: (options: RunOptions) => {
      commands.push(options);
      return run(options);
    },
    setNetworkPolicy: () => Promise.resolve(),
    writeTextFile: ({ content }: { content: string }) => {
      written.push(content);
      return Promise.resolve();
    },
  } as unknown as SandboxSession;
  return { commands, sandbox, written };
};

const markerFor = (
  slug: string,
  source: "explicit" | "github-webhook" = "explicit",
  worktree = "/workspace/repo"
) => ({ slug, source, worktree });

/**
 * Runs the tool's preparation against a marked-up sandbox. `/workspace` is
 * never a repository here, so the checkout always lives at `/workspace/repo`,
 * which is the only shape a switch is allowed in.
 */
const prepare = async (
  requested: string | undefined,
  marker: unknown,
  auth: SessionAuthContext | null,
  run: (options: RunOptions) => Promise<RunResult> = () => ok(HEAD_BEFORE)
) => {
  const { commands, sandbox, written } = preparedSandbox(marker, (options) =>
    options.command.includes("rev-parse --show-toplevel")
      ? failed("not a git repository")
      : run(options)
  );
  const result = (await prepareRepositoryWorkspace(
    requested,
    {
      getSandbox: () => Promise.resolve(sandbox),
      session: { auth: { current: auth } },
    },
    { broker, timeoutMs: TIMEOUT_MS }
  )) as {
    current?: { repository: string; source: string };
    error?: string;
    previous?: { repository: string; source: string } | null;
    replaced?: boolean;
    reused?: boolean;
    success?: boolean;
  };
  return { commands, result, written };
};

describe("prepare_repository switching", () => {
  it("reuses the repository it already prepared", async () => {
    const { commands, result } = await prepare(
      REPOSITORY,
      markerFor(REPOSITORY),
      attendedAuth
    );
    assert.equal(result.success, true);
    assert.equal(result.reused, true);
    assert.equal(result.replaced, false);
    assert.deepEqual(result.previous, {
      repository: REPOSITORY,
      source: "explicit",
    });
    assert.deepEqual(result.current, {
      repository: REPOSITORY,
      source: "explicit",
    });
    assert.equal(commands.length, 0);
  });

  it("replaces a different repository for an attended explicit request", async () => {
    const { commands, result, written } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) =>
        options.command.startsWith("test ") ? failed("") : ok(HEAD_BEFORE)
    );
    assert.equal(result.success, true);
    assert.equal(result.replaced, true);
    assert.deepEqual(result.previous, {
      repository: REPOSITORY,
      source: "explicit",
    });
    assert.deepEqual(result.current, { repository: OTHER, source: "explicit" });
    assert.ok(ran(commands, SET_ASIDE));
    assert.ok(ran(commands, `git clone --depth 50 ${remoteUrl(OTHER)}`));
    assert.ok(ran(commands, PUBLISH));
    assert.ok(ran(commands, DISCARD_PREVIOUS));
    assert.equal(ran(commands, RESTORE), false);
    assert.match(written.at(-1) ?? "", MARKED_OTHER);
  });

  it("refuses to replace the checkout a signed GitHub session is bound to", async () => {
    const { commands, result, written } = await prepare(
      OTHER,
      markerFor(REPOSITORY, "github-webhook"),
      stampRepository(attendedAuth, REPOSITORY, "github-webhook")
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", SIGNED_REFUSAL);
    assert.equal(ran(commands, SET_ASIDE), false);
    assert.deepEqual(written, []);
  });

  it("refuses a signed session's retarget before it reaches the checkout", async () => {
    // `resolveRepository` rejects the request itself, so the marker is never
    // even consulted: message text cannot redirect a signed webhook.
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY, "github-webhook"),
      stampRepository(attendedAuth, REPOSITORY, "github-webhook")
    );
    assert.equal(result.success, false);
    assert.equal(ran(commands, "git clone"), false);
  });

  it("refuses to switch in an unattended run", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      stampUnattended(attendedAuth)
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", UNATTENDED_REFUSAL);
    assert.equal(ran(commands, SET_ASIDE), false);
  });

  it("refuses to replace the session workspace checkout", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY, "explicit", "/workspace"),
      attendedAuth
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", WORKSPACE_REFUSAL);
    assert.equal(ran(commands, SET_ASIDE), false);
  });

  it("restores the previous checkout when the replacement clone fails", async () => {
    const { commands, result, written } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command.startsWith("git clone")) {
          return failed("fatal: repository not found");
        }
        return options.command.startsWith("test ") ? failed("") : ok();
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", CLONE_FAILED);
    assert.match(result.error ?? "", PREVIOUS_KEPT);
    assert.ok(ran(commands, DISCARD_STAGING));
    assert.ok(ran(commands, RESTORE));
    // The marker still names the repository that is back on disk.
    assert.deepEqual(written, []);
    assert.equal(ran(commands, DISCARD_MARKER), false);
  });

  it("clears the marker when the previous checkout cannot be restored", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command.startsWith("git clone")) {
          return failed("fatal: repository not found");
        }
        if (options.command === RESTORE) {
          return failed("mv: cross-device link");
        }
        return options.command.startsWith("test ") ? failed("") : ok();
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", PREVIOUS_LOST);
    assert.ok(ran(commands, DISCARD_MARKER));
  });

  it("keeps the previous checkout when it cannot be set aside", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) =>
        options.command === SET_ASIDE ? failed("mv: permission denied") : ok()
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", PREVIOUS_KEPT);
    assert.equal(ran(commands, "git clone"), false);
    assert.equal(ran(commands, DISCARD_MARKER), false);
  });
});

describe("prepare_repository lockfile installs", () => {
  /** Refreshes a warmed checkout whose HEAD moved, with the diff answered. */
  const refreshMovedHead = (lockfile: (options: RunOptions) => RunResult) => {
    let revisions = 0;
    return fakeSandbox((options) => {
      if (options.command.includes("rev-parse HEAD")) {
        revisions += 1;
        return ok(revisions === 1 ? HEAD_BEFORE : HEAD_AFTER);
      }
      return options.command.includes(LOCKFILE_DIFF)
        ? Promise.resolve(lockfile(options))
        : ok();
    });
  };

  it("skips the install when HEAD moved but the lockfile did not", async () => {
    const { commands, sandbox } = refreshMovedHead(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
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
    assert.ok(
      ran(
        commands,
        `git -C /workspace/repo diff --name-only ${HEAD_BEFORE} ${HEAD_AFTER} -- pnpm-lock.yaml`
      )
    );
    assert.equal(ran(commands, "pnpm install"), false);
    assert.equal(ran(commands, DISCARD), false);
  });

  it("installs when the lockfile moved with HEAD", async () => {
    const { commands, sandbox } = refreshMovedHead(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "pnpm-lock.yaml\n",
    }));
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
    assert.ok(ran(commands, "pnpm install --frozen-lockfile"));
  });

  it("installs when the lockfile diff cannot be read", async () => {
    const { commands, sandbox } = refreshMovedHead(() => ({
      exitCode: 128,
      stderr: "fatal: bad object",
      stdout: "",
    }));
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
    assert.ok(ran(commands, "pnpm install --frozen-lockfile"));
  });

  it("reads the bun lockfile for a bun repository", async () => {
    const { commands, sandbox } = refreshMovedHead(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    await refreshCheckout(
      sandbox,
      "Acquisity/Acquisity",
      { kind: "bun", slug: "Acquisity/Acquisity" },
      false,
      { broker, timeoutMs: TIMEOUT_MS }
    );
    assert.ok(ran(commands, "-- bun.lock"));
    assert.equal(ran(commands, "bun install"), false);
  });

  it("installs without a diff when the checkout's install state is unknown", async () => {
    const { commands, sandbox } = refreshMovedHead(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    assert.equal(
      await refreshCheckout(
        sandbox,
        REPOSITORY,
        { kind: "pnpm", slug: REPOSITORY },
        true,
        { broker, timeoutMs: TIMEOUT_MS }
      ),
      null
    );
    assert.equal(ran(commands, LOCKFILE_DIFF), false);
    assert.ok(ran(commands, "pnpm install --frozen-lockfile"));
  });
});
