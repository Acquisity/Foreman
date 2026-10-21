import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import evePackage from "eve/package.json" with { type: "json" };
import { githubCredentials } from "./github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "./github/git-remote.js";
import { remoteUrl } from "./repository.js";
import {
  BUN_INSTALL_CACHE_DIR,
  bunInstallCommand,
  PNPM_STORE_DIR,
  WARM_REPOSITORIES,
  WARM_ROOT,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
} from "./repository-warmup.js";

/**
 * The image the snapshot is built from: eve 0.81's Vercel sandbox image,
 * `vcr.vercel.com/vercel/eve/base:<tag>`, derived the way eve derives it
 * (`EVE_SANDBOX_IMAGE_TAG` when set, else the installed eve version without
 * build metadata). eve's resolver is not exported, so this mirrors it.
 *
 * It must match because eve passes no image when the session source is a
 * snapshot: the session runs on the snapshot's own filesystem. A snapshot built
 * from another image (eve 0.54's older `vercel/eve` image) has no `/vercel/sandbox`,
 * and every session fails with "chdir /vercel/sandbox: no such file or
 * directory". Any eve upgrade therefore requires a snapshot rebuild.
 */
export const eveSandboxImage = (): string => {
  const override = process.env.EVE_SANDBOX_IMAGE_TAG?.trim();
  const tag = override ? override : evePackage.version.split("+", 1)[0];
  return `vcr.vercel.com/vercel/eve/base:${tag}`;
};

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
 * Builds the warm repository snapshot: clones and installs every configured
 * repository in a throwaway sandbox running eve's own image, then snapshots the
 * result and returns the snapshot id.
 *
 * Dependencies only, no build. Acquisity/Acquisity validates a long list of
 * required API keys and secrets at build time, and secrets never enter a
 * Foreman sandbox, so a pre-build here could only ever fail. Stations build on
 * demand with the environment they are given, against the warm install this
 * produces.
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
    image: eveSandboxImage(),
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
    // install steps run after the token window closes so lifecycle scripts
    // never execute with the credential on the wire.
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

    // Also after the token window: installing bun runs the npm package's own
    // lifecycle scripts, which is the same hazard as a repository's.
    if (WARM_REPOSITORIES.some((repository) => repository.kind === "bun")) {
      await run(sandbox, bunInstallCommand());
    }

    await Promise.all(
      WARM_REPOSITORIES.map(async (repository) => {
        const path = warmRepositoryPath(repository.slug);
        await run(sandbox, warmInstallCommand(repository.kind), {
          cwd: path,
          env: warmInstallEnv(repository.kind),
        });
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
