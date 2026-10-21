import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { boundedRun } from "#lib/sandbox-deadline.js";
import { isWidgetSupport } from "#lib/widget-scope.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox environment for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel. The 2 vCPUs (4 GB memory) stay explicit rather than riding a
 * platform default that can change out from under us.
 *
 * The repositories (Acquisity/Foreman and Acquisity/Acquisity) are warmed out of
 * band by the `rebuild_warm_snapshot` tool, which clones, installs, and builds them in a
 * throwaway sandbox and snapshots the result. It is run on request, when the warm-up itself
 * changes, rather than on a cadence: `prepare_repository` refreshes the warmed checkout to
 * the remote HEAD on every session, so an older snapshot costs a slightly longer install,
 * not correctness. The environment starts from that snapshot via
 * `source: { type: "snapshot", snapshotId }`, so `prepare_repository` and delegated work
 * begin from a warm checkout instead of a full install on every fresh session. The
 * snapshot id is read synchronously from `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` because `source`
 * is honored only when eve prepares the environment at build time; when it is unset the
 * environment omits `source` and `prepare_repository` cold-clones, which is the safe
 * fallback before the first snapshot exists. eve's environment configuration hash includes
 * `source`, so a new snapshot id prepares a new environment. eve does not detect a snapshot
 * rebuilt under the same id. The snapshot carries eve's base sandbox image, so it must be
 * rebuilt after any eve upgrade.
 *
 * The selector marks `/workspace` as a safe git directory before the GitHub channel's
 * built-in per-turn checkout runs there. The sandbox filesystem is owned by the builder uid,
 * not the session user, so without this git aborts every command with "detected dubious
 * ownership in repository at '/workspace'", the channel swallows the failed checkout, and the
 * turn runs with no working tree. The same hazard for `/workspace/repo`
 * and the prepared worktree is handled in `agent/tools/prepare_repository.ts`.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */

const snapshotId = process.env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID;

export const environment = VercelSandbox.environment(
  snapshotId
    ? { resources: { vcpus: 2 }, source: { snapshotId, type: "snapshot" } }
    : { resources: { vcpus: 2 } }
);

export const sandboxSessionOptions = (
  initiator: Parameters<typeof isWidgetSupport>[0]
) =>
  isWidgetSupport(initiator)
    ? { networkPolicy: "deny-all" as const }
    : undefined;

export default defineSandbox(async ({ session }) => {
  const sandbox = await environment.open(
    sandboxSessionOptions(session.auth.initiator)
  );
  const result = await boundedRun(sandbox, {
    command: "git config --global --add safe.directory /workspace",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
        result.stderr || result.stdout
      ).trim()}`
    );
  }
  return sandbox;
});
