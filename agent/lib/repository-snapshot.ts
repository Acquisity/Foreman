import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import { githubCredentials } from "./github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "./github/git-remote.js";
import { remoteUrl } from "./repository.js";
import {
  BUN_INSTALL_CACHE_DIR,
  PNPM_STORE_DIR,
  WARM_REPOSITORIES,
  WARM_ROOT,
  warmBuildCommand,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
} from "./repository-warmup.js";

/**
 * The image the snapshot is built from. It must match eve's own sandbox image
 * (`VERCEL_EVE_SANDBOX_IMAGE` = "vercel/eve:latest") so the installed deps
 * (bun/pnpm/node_modules and any native binaries) are built against the same
 * toolchain the sessions run on, and so the template built from this snapshot
 * inherits the eve image rather than pinning a stock runtime. If eve bumps its
 * image, this must track it.
 */
const EVE_SANDBOX_IMAGE = "vercel/eve:latest";

// Snapshots expire 30 days after their last use. Rebuilds are human-driven and
// rare, so the TTL bounds storage from superseded snapshots when a rebuild does
// happen; the active snapshot, pinned as the template base, keeps resetting its
// timer on use so it stays alive between rebuilds.
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The invocation that drives this build is capped by eve's Vercel maxDuration
// ("max", 800s on Pro Fluid), so the sandbox timeout is bounded by that
// ceiling, not by how long the build could take. Keeping the sandbox timeout at
// the invocation ceiling means an orphaned sandbox (the function killed
// mid-build) self-terminates instead of leaking past the function's death. The
// build must fit inside this window; decoupling it from the invocation is the
// follow-up if it does not.
const BUILD_TIMEOUT_MS = 800_000;

const failure = (
  label: string,
  result: { stdout: string; stderr: string }
): string => `${label}: ${String(result.stderr || result.stdout).trim()}`;

/**
 * Runs a shell command in the snapshot sandbox, throwing on a non-zero exit.
 */
const run = async (
  sandbox: Sandbox,
  command: string,
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<void> => {
  const result = await sandbox.runCommand({
    args: ["-lc", command],
    cmd: "/bin/bash",
    cwd: options.cwd,
    env: options.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      failure(command, {
        stderr: await result.stderr(),
        stdout: await result.stdout(),
      })
    );
  }
};

/**
 * Builds the warm repository snapshot: clones, installs (and builds, for Bun
 * repos) every configured repository in a throwaway sandbox running eve's own
 * image, then snapshots the result and returns the snapshot id.
 *
 * Driven by the `rebuild_warm_snapshot` tool. The produced id is what
 * `agent/sandbox.ts` reads from `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` to seed the
 * session template. The whole checkout — including `.git`, the tracked
 * working-tree files, and `node_modules` — lands in the snapshot; `chmod` makes
 * them readable/writable by the session user, which runs as a different uid
 * than the snapshot builder, so the later `git reset --hard` and station edits
 * succeed.
 */
export const createWarmSnapshot = async (): Promise<string> => {
  const token = await mintInstallationToken(githubCredentials);
  // `brokerPolicy` is typed against eve's `SandboxNetworkPolicy`, which is
  // structurally identical to `@vercel/sandbox`'s `NetworkPolicy`; the cast
  // bridges the two otherwise-unrelated type identities.
  const networkPolicy = brokerPolicy(token) as unknown as NetworkPolicy;

  const sandbox = await Sandbox.create({
    image: EVE_SANDBOX_IMAGE,
    networkPolicy,
    resources: { vcpus: 4 },
    timeout: BUILD_TIMEOUT_MS,
  });

  try {
    await run(
      sandbox,
      `mkdir -p ${WARM_ROOT} ${PNPM_STORE_DIR} ${BUN_INSTALL_CACHE_DIR}`
    );

    // Clone first, while the brokered GitHub token is still injected; the
    // install/build steps run after the token window closes so lifecycle
    // scripts never execute with the credential on the wire.
    await Promise.all(
      WARM_REPOSITORIES.map(async (repository) => {
        const path = warmRepositoryPath(repository.slug);
        await run(
          sandbox,
          `git clone --depth 50 ${remoteUrl(repository.slug)} ${path}`
        );
      })
    );

    await sandbox.update({ networkPolicy: "allow-all" });

    await Promise.all(
      WARM_REPOSITORIES.map(async (repository) => {
        const path = warmRepositoryPath(repository.slug);
        const env = warmInstallEnv(repository.kind);
        await run(sandbox, warmInstallCommand(repository.kind), {
          cwd: path,
          env,
        });
        const build = warmBuildCommand(repository.kind);
        if (build) {
          await run(sandbox, build, { cwd: path, env });
        }
      })
    );

    // Make the workspace writable for the session user, which runs as a
    // different uid than the builder: it renames the warm checkout into
    // `/workspace/repo` (write on `/workspace`), writes
    // `/workspace/.foreman/repository.json` (write on `/workspace/.foreman`),
    // and the runtime install writes into the shared package stores.
    // `chmod -R a+rwX /workspace` covers all of them.
    await run(sandbox, "chmod -R a+rwX /workspace");

    const snapshot = await sandbox.snapshot({ expiration: SNAPSHOT_TTL_MS });
    return snapshot.snapshotId;
  } catch (error) {
    // `snapshot()` stops the sandbox on the happy path only; on any failure
    // the sandbox would otherwise keep running until its timeout.
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
};
