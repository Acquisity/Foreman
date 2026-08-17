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
 * The `onSession` hook marks `/workspace` as a safe git directory before the GitHub channel's
 * built-in per-turn checkout runs there. The sandbox filesystem is owned by the builder uid,
 * not the session user, so without this git aborts every command with "detected dubious
 * ownership in repository at '/workspace'", the channel swallows the failed checkout, and the
 * turn runs with no working tree. The station sandboxes handle the same hazard for
 * `/workspace/repo` in `agent/lib/github/repo-sandbox.ts`.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel({ resources: { vcpus: 2 } }),
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
  revalidationKey: () => agentBrowserRevalidationKey(),
});
