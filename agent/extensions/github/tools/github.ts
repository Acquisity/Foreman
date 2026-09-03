import { github } from "@github-tools/eve-extension/tools";
import { defineDynamic } from "eve/tools";
import { repositoryCapabilitiesAvailable } from "../../../lib/repository-lane.js";

/**
 * Keeps the 31-tool GitHub surface out of a lane that has no repository
 * selected and no factory path open to it.
 *
 * @remarks
 * This file overrides the extension's own `tools/github.ts` slot, which is the
 * only place eve 0.44 lets a consumer gate an extension's tools: a directory
 * mount replaces a same-named contribution, and a dynamic definition replaces
 * a dynamic one. The mount itself stays in `../extension.ts` next to this
 * file, with the allowlist, the `requireApproval: false`, and the durable
 * overrides unchanged.
 *
 * The gate wraps the extension's resolver rather than rebuilding its tools.
 * That is load-bearing for two reasons. eve stamps a durable callback
 * descriptor only where the callback is authored inline in a transformed
 * `defineTool` call, and every one of the extension's `execute`, `approval`,
 * and `toModelOutput` callbacks is stamped inside its own bundled module; a
 * reimplementation here would carry none, and eve 0.44 drops the whole 31-tool
 * map when a single entry lacks one, silently. And the descriptors the
 * extension resolves are read from its own dist, so a version bump changes the
 * tool set here with no edit.
 *
 * `step.started` is the extension's own event and is kept, so an admitted lane
 * resolves exactly what it resolved before. `null` is reserved for the lane
 * gate. A missing slot throws instead, naming the package and the key: the
 * resolver loses its result either way, but a throw is visible in tests and
 * `eve info` before deploy, while `null` would look like a gated lane and drop
 * all 31 tools from every lane silently. `agent/lib/repository-lane.ts`
 * owns the decision; it gates the catalog only. Every write these tools
 * perform stays gated where it already is, and a signed webhook still binds
 * its session to one repository.
 */
export default defineDynamic({
  events: {
    "step.started": async (event, ctx) => {
      if (!repositoryCapabilitiesAvailable(ctx.session.auth.current)) {
        return null;
      }
      const resolve = github.events["step.started"];
      if (resolve === undefined) {
        throw new Error(
          "@github-tools/eve-extension exposes no step.started resolver to forward; the GitHub tool override cannot gate a slot that moved"
        );
      }
      return await resolve(event, ctx);
    },
  },
});
