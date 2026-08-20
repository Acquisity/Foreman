import { defineTool } from "eve/tools";
import { z } from "zod";
import { warmSnapshotPolicy } from "#lib/github/approval.js";
import { createWarmSnapshot } from "#lib/repository-snapshot.js";

/**
 * Rebuilds the warm repository snapshot on request.
 *
 * @remarks
 * The snapshot only has to be a good starting point, not the latest commit:
 * `prepare_repository` refreshes the warmed checkout to the remote HEAD and
 * reinstalls when it moves, so a snapshot goes stale in dependencies rather
 * than in code, and both repositories change their lockfiles a few times a
 * week at most. Rebuilding is therefore worth it when the warm-up itself
 * changes (a new repository, a different install command, a cache layout
 * move), which is why this is a tool rather than a cron.
 *
 * The returned id is not applied automatically. Set it as
 * `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` and redeploy, because the sandbox
 * template's `source` is fixed at template build time.
 */
export default defineTool({
  approval: warmSnapshotPolicy,
  description:
    "Rebuild the warm dependency snapshot for the pre-warmed repositories and return its id. Takes several minutes. Run it after the warm-up itself changes, not to pick up new commits. The id must then be set as VERCEL_SANDBOX_BASE_SNAPSHOT_ID and the app redeployed before it takes effect.",
  execute: async () => {
    try {
      const snapshotId = await createWarmSnapshot();
      return {
        nextStep:
          "Set VERCEL_SANDBOX_BASE_SNAPSHOT_ID to this id in the Vercel project, then redeploy so the sandbox template is rebuilt from it.",
        snapshotId,
        success: true as const,
      };
    } catch (error) {
      return {
        error: `Could not rebuild the warm snapshot: ${error instanceof Error ? error.message : "unknown error"}`,
        success: false as const,
      };
    }
  },
  inputSchema: z.object({}),
});
