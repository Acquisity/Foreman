import {
  agentBrowserRevalidationKey,
  installAgentBrowser,
} from "@agent-browser/eve/sandbox";
import {
  defineSandbox,
  type SandboxBootstrapContext,
  type SandboxSessionContext,
} from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import { warmSnapshotRevalidationKey } from "#lib/repository-warmup.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * The 2 vCPUs (4 GB memory) are pinned for Chromium: the platform default happens to match
 * today, but an under-provisioned browser degrades as timeouts rather than errors, so the
 * sizing stays explicit instead of riding a default that can change out from under us.
 *
 * The bootstrap pre-installs agent-browser (with Chromium and its system libraries) at
 * template build time, so the `browser` extension's tools start from a warm snapshot instead
 * of paying the install on first use in every fresh sandbox; the revalidation key rebuilds
 * the template when the pinned agent-browser version changes.
 *
 * The factory repositories (Acquisity/Foreman and Acquisity/Acquisity) are warmed out of
 * band by the `rebuild_warm_snapshot` tool, which clones, installs, and builds them in a
 * throwaway sandbox and snapshots the result. It is run on request, when the warm-up itself
 * changes, rather than on a cadence: `prepare_repository` refreshes the warmed checkout to
 * the remote HEAD on every session, so an older snapshot costs a slightly longer install,
 * not correctness. The template starts from that snapshot via
 * `source: { type: "snapshot", snapshotId }`, so `prepare_repository` and the station
 * sandboxes begin from a warm checkout instead of a full install on every fresh session. The
 * snapshot id is read synchronously from `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` because `source`
 * is fixed at template build time; when it is unset the template omits `source` and
 * `prepare_repository` cold-clones, which is the safe fallback before the first snapshot
 * exists. The revalidation key folds in the snapshot id so a rebuilt snapshot rebuilds the
 * template.
 *
 * The `onSession` hook marks `/workspace` as a safe git directory before the GitHub channel's
 * built-in per-turn checkout runs there. The sandbox filesystem is owned by the builder uid,
 * not the session user, so without this git aborts every command with "detected dubious
 * ownership in repository at '/workspace'", the channel swallows the failed checkout, and the
 * turn runs with no working tree. The station sandboxes handle the same hazard for
 * `/workspace/repo` in `agent/lib/github/repo-sandbox.ts`.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */

const snapshotId = process.env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID;

const backend = snapshotId
  ? vercel({
      resources: { vcpus: 2 },
      source: { snapshotId, type: "snapshot" },
    })
  : vercel({ resources: { vcpus: 2 } });

export default defineSandbox({
  backend,
  async bootstrap({ use }: SandboxBootstrapContext): Promise<void> {
    const sandbox = await use();
    await installAgentBrowser(sandbox);
  },
  async onSession({ use }: SandboxSessionContext): Promise<void> {
    const sandbox = await use();
    const result = await sandbox.run({
      command: "git config --global --add safe.directory /workspace",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
          result.stderr || result.stdout
        ).trim()}`
      );
    }
  },
  revalidationKey: () =>
    [
      agentBrowserRevalidationKey(),
      warmSnapshotRevalidationKey(snapshotId),
    ].join(":"),
});
