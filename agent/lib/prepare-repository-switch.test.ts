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
const RECOVER = `if [ -e ${PREVIOUS} ] && [ ! -e /workspace/repo ]; then mv ${PREVIOUS} /workspace/repo; fi`;
const SET_ASIDE = `${RECOVER} && rm -rf ${PREVIOUS} && mv /workspace/repo ${PREVIOUS}`;
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

  it("recovers a stranded checkout before setting it aside again", async () => {
    const { commands } = await prepare(
      OTHER,
      markerFor(REPOSITORY),
      attendedAuth,
      (options) => (options.command.startsWith("test ") ? failed("") : ok())
    );
    const setAside = commands.find((options) =>
      options.command.includes("mv /workspace/repo")
    );
    assert.ok(setAside?.command.startsWith(RECOVER));
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
