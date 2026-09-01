import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import {
  broker,
  CANCELLED,
  CLONE_FAILED,
  CLONE_THREW,
  DISCARD_STAGING,
  failed,
  HEAD_BEFORE,
  ok,
  PUBLISH,
  REPOSITORY,
  type RunOptions,
  type RunResult,
  ran,
  TIMEOUT_MS,
} from "./prepare-repository-fixtures.js";
import { REPOSITORY_MARKER, remoteUrl, stampRepository } from "./repository.js";
import { stampUnattended } from "./trust.js";

const { prepareRepositoryWorkspace } = await import(
  "../tools/prepare_repository.js"
);

const OTHER = "Acquisity/Other";
const PREVIOUS = "/workspace/.repo-previous";
const RECOVER = `if [ -e ${PREVIOUS} ]; then if [ -e /workspace/repo ]; then echo "origin=$(git config --file /workspace/repo/.git/config --get remote.origin.url)"; else mv ${PREVIOUS} /workspace/repo; fi; elif [ ! -e /workspace/repo ]; then echo "missing-checkout"; fi`;
const SET_ASIDE = `rm -rf ${PREVIOUS} && mv /workspace/repo ${PREVIOUS}`;
const STRANDED = `origin=${remoteUrl(OTHER)}`;
const IN_PLACE = `origin=${remoteUrl(REPOSITORY)}`;
const RECOVERY_FAILED = /Could not restore the prepared checkout/u;
const ORIGIN_UNREADABLE =
  /Could not tell which repository the checkout beside/u;
const STRANDED_LOST = /The prepared Acquisity\/Foreman could not be restored/u;
const CONFIG_THREW = /config file locked/u;
const RESTORE = `rm -rf /workspace/repo && mv ${PREVIOUS} /workspace/repo`;
const DISCARD_PREVIOUS = `rm -rf ${PREVIOUS}`;
const DISCARD_MARKER = `rm -rf ${REPOSITORY_MARKER}`;
const SIGNED_REFUSAL = /signed GitHub session is bound/u;
const UNATTENDED_REFUSAL = /unattended session already prepared/u;
const WORKSPACE_REFUSAL = /session workspace itself/u;
const PREVIOUS_KEPT = /Acquisity\/Foreman is still in place/u;
const CONFIG_FAILED = /Could not configure the workspace/u;
const MARKER_WRITE_FAILED = /Could not record the prepared Acquisity\/Other/u;
const CONFIGURE = "user.name";
const PREVIOUS_LOST = /could not be restored/u;
const NO_REPOSITORY = /no repository prepared/u;
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
  run: (options: RunOptions) => Promise<RunResult>,
  write: () => Promise<void> = () => Promise.resolve()
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
      return write();
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
  run: (options: RunOptions) => Promise<RunResult> = () => ok(HEAD_BEFORE),
  write?: () => Promise<void>
) => {
  const { commands, sandbox, written } = preparedSandbox(
    marker,
    (options) =>
      options.command.includes("rev-parse --show-toplevel")
        ? failed("not a git repository")
        : run(options),
    write
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
    // The only work a reuse does is putting back a checkout an interrupted
    // switch stranded, so the marker it reuses names something on disk.
    assert.deepEqual(
      commands.map((options) => options.command),
      [RECOVER]
    );
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
    assert.equal(ran(commands, RESTORE), false);
    assert.match(written.at(-1) ?? "", MARKED_OTHER);
    // The set-aside checkout is the rollback source until the marker names its
    // replacement, so it is discarded last of all.
    assert.equal(commands.at(-1)?.command, DISCARD_PREVIOUS);
  });

  it("refuses to replace the checkout a signed GitHub session is bound to", async () => {
    const { commands, result, written } = await prepare(
      OTHER,
      markerFor(REPOSITORY, "github-webhook"),
      attendedAuth
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

  it("puts the previous checkout back when a switch throws", async () => {
    const { commands, sandbox, written } = preparedSandbox(
      markerFor(REPOSITORY),
      (options) => {
        if (options.command.includes("rev-parse --show-toplevel")) {
          return failed("not a git repository");
        }
        if (options.command.startsWith("git clone")) {
          return Promise.reject(new Error("sandbox gone"));
        }
        return options.command.startsWith("test ") ? failed("") : ok();
      }
    );
    await assert.rejects(
      prepareRepositoryWorkspace(
        OTHER,
        {
          getSandbox: () => Promise.resolve(sandbox),
          session: { auth: { current: attendedAuth } },
        },
        { broker, timeoutMs: TIMEOUT_MS }
      ),
      CLONE_THREW
    );
    assert.ok(ran(commands, RESTORE));
    assert.deepEqual(written, []);
  });

  it("rethrows a cancelled switch and leaves the checkout recoverable", async () => {
    // eve binds the cancelled turn's signal into every later command, so the
    // restore cannot run: the previous checkout stays at the tool-owned path
    // for the next attempt to move back.
    const turn = AbortSignal.abort(new Error("turn cancelled"));
    let cancelled = false;
    const { commands, sandbox, written } = preparedSandbox(
      markerFor(REPOSITORY),
      (options) => {
        if (options.command.includes("rev-parse --show-toplevel")) {
          return failed("not a git repository");
        }
        if (options.command === SET_ASIDE) {
          cancelled = true;
          return ok();
        }
        if (!cancelled) {
          return options.command.startsWith("test ") ? failed("") : ok();
        }
        const composed = options.abortSignal
          ? AbortSignal.any([turn, options.abortSignal])
          : turn;
        return Promise.reject(composed.reason);
      }
    );
    await assert.rejects(
      prepareRepositoryWorkspace(
        OTHER,
        {
          getSandbox: () => Promise.resolve(sandbox),
          session: { auth: { current: attendedAuth } },
        },
        { broker, timeoutMs: TIMEOUT_MS }
      ),
      CANCELLED
    );
    // The restore was attempted even though the cancelled turn refused it.
    assert.ok(ran(commands, RESTORE));
    assert.deepEqual(written, []);
  });

  it("restores a stranded checkout before setting it aside again", async () => {
    const { commands } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command === RECOVER) {
          return ok(STRANDED);
        }
        return options.command.startsWith("test ") ? failed("") : ok();
      }
    );
    // The set-aside deletes whatever waits at the previous path and moves what
    // is published into it, so the marker's own checkout has to be back in
    // place first or the switch sets aside a checkout nothing recorded and
    // deletes the only copy of the one it did.
    const order = commands.map((options) => options.command);
    assert.ok(order.includes(RESTORE));
    assert.ok(order.indexOf(RESTORE) < order.indexOf(SET_ASIDE));
  });

  it("rolls back a checkout published for a repository the marker does not name", async () => {
    // A turn cancelled after the replacement was published but before the
    // marker named it leaves both paths populated. The marker is what the
    // session answers for, so its own checkout is the one that goes back.
    const { commands, result } = await prepare(
      REPOSITORY,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => (options.command === RECOVER ? ok(STRANDED) : ok())
    );
    assert.equal(result.success, true);
    assert.equal(result.reused, true);
    assert.ok(ran(commands, RESTORE));
  });

  it("refuses to reuse when a stranded checkout cannot be restored", async () => {
    const { commands, result, written } = await prepare(
      REPOSITORY,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command === RECOVER) {
          return ok(STRANDED);
        }
        return options.command === RESTORE
          ? failed("mv: cross-device link")
          : ok();
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", STRANDED_LOST);
    assert.ok(ran(commands, DISCARD_MARKER));
    assert.deepEqual(written, []);
  });

  it("discards the set-aside copy left beside the checkout the marker names", async () => {
    const { commands, result } = await prepare(
      REPOSITORY,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => (options.command === RECOVER ? ok(IN_PLACE) : ok())
    );
    assert.equal(result.reused, true);
    assert.ok(ran(commands, DISCARD_PREVIOUS));
    assert.equal(ran(commands, RESTORE), false);
  });

  it("fails closed when the recovery cannot run", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) =>
        options.command === RECOVER ? failed("mv: permission denied") : ok()
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", RECOVERY_FAILED);
    assert.equal(ran(commands, SET_ASIDE), false);
    assert.equal(ran(commands, "git clone"), false);
  });

  it("clears a marker whose checkout has disappeared", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => (options.command === RECOVER ? ok("missing-checkout") : ok())
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", NO_REPOSITORY);
    assert.ok(ran(commands, DISCARD_MARKER));
    assert.equal(ran(commands, SET_ASIDE), false);
    assert.equal(ran(commands, "git clone"), false);
  });

  it("fails closed when the published checkout's origin cannot be read", async () => {
    const { commands, result } = await prepare(
      REPOSITORY,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => (options.command === RECOVER ? ok("origin=") : ok())
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", ORIGIN_UNREADABLE);
    assert.equal(ran(commands, RESTORE), false);
    assert.equal(ran(commands, DISCARD_PREVIOUS), false);
  });

  it("restores the previous checkout when the workspace configuration throws", async () => {
    const { commands, result, written } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command.includes(CONFIGURE)) {
          return Promise.reject(new Error("config file locked"));
        }
        return options.command.startsWith("test ") ? failed("") : ok();
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", CONFIG_THREW);
    assert.match(result.error ?? "", PREVIOUS_KEPT);
    assert.ok(ran(commands, RESTORE));
    assert.deepEqual(written, []);
  });

  it("restores the previous checkout when the workspace cannot be configured", async () => {
    const { commands, result, written } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command.includes(CONFIGURE)) {
          return failed("could not lock config file");
        }
        return options.command.startsWith("test ") ? failed("") : ok();
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", CONFIG_FAILED);
    assert.match(result.error ?? "", PREVIOUS_KEPT);
    assert.ok(ran(commands, RESTORE));
    // The marker still names the repository that is back on disk.
    assert.deepEqual(written, []);
    assert.equal(ran(commands, DISCARD_MARKER), false);
  });

  it("restores the previous checkout when the marker cannot be written", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => (options.command.startsWith("test ") ? failed("") : ok()),
      () => Promise.reject(new Error("blob write failed"))
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", MARKER_WRITE_FAILED);
    assert.match(result.error ?? "", PREVIOUS_KEPT);
    assert.ok(ran(commands, RESTORE));
    assert.equal(ran(commands, DISCARD_MARKER), false);
  });

  it("clears the marker when a failed configuration cannot be rolled back", async () => {
    const { commands, result } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => {
        if (options.command.includes(CONFIGURE)) {
          return failed("could not lock config file");
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
