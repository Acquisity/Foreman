import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import { githubCredentials } from "./github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "./github/git-remote.js";
import { remoteUrl } from "./repository.js";
import {
  BUN_INSTALL_CACHE_DIR,
  PNPM_STORE_DIR,
  WARM_REPOSITORIES,
  WARM_ROOT,
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

// Snapshots expire 30 days after their last use so the daily rebuild does not
// leak unbounded storage; the snapshot in active use as the template base keeps
// resetting its timer, so only superseded ones age out.
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const failure = (
  label: string,
  result: { exitCode: number; stdout: string; stderr: string }
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
    args: ["-c", command],
    cmd: "/bin/bash",
    cwd: options.cwd,
    env: options.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      failure(command, {
        exitCode: result.exitCode,
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
 * The produced id is what `agent/sandbox.ts` reads from
 * `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` to seed the session template. The whole
 * checkout — including `.git`, the tracked working-tree files, and
 * `node_modules` — lands in the snapshot; `chmod` makes them readable/writable
 * by the session user, which runs as a different uid than the snapshot builder,
 * so the later `git reset --hard` and station edits succeed.
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
    resources: { vcpus: 2 },
  });

  await run(
    sandbox,
    `mkdir -p ${WARM_ROOT} ${PNPM_STORE_DIR} ${BUN_INSTALL_CACHE_DIR}`
  );

  // A failure already names its repository in the error message, so the
  // concurrent warm-up stays attributable while keeping the installs fast.
  await Promise.all(
    WARM_REPOSITORIES.map(async (repository) => {
      const path = warmRepositoryPath(repository.slug);
      const env = warmInstallEnv(repository.kind);
      await run(
        sandbox,
        `git clone --depth 1 ${remoteUrl(repository.slug)} ${path}`
      );
      await run(sandbox, warmInstallCommand(repository.kind), {
        cwd: path,
        env,
      });
      if (repository.kind === "bun") {
        await run(sandbox, "bun run build", { cwd: path, env });
      }
    })
  );

  // Make the warm root and cache dirs writable too: the session user renames
  // `/workspace/.foreman/warm/<slug>` to `/workspace/repo`, which needs write
  // permission on the builder-owned parent (mode 755), and the runtime install
  // writes into the shared package stores.
  await run(
    sandbox,
    `chmod -R a+rwX ${WARM_ROOT} ${PNPM_STORE_DIR} ${BUN_INSTALL_CACHE_DIR}`
  );

  const snapshot = await sandbox.snapshot({ expiration: SNAPSHOT_TTL_MS });
  return snapshot.snapshotId;
};
