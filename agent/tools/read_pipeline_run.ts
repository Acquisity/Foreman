import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { pipelineScopeSchema, readPipelineRun } from "#lib/pipeline-runs.js";
import { resolveRepositoryInput } from "#lib/repository.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";

export const readPipelineRunTool = defineTool({
  description: "Read one durable factory pipeline run by repository and scope.",
  async execute({ repository, scope }, ctx) {
    try {
      const target = resolveRepositoryInput(
        repository,
        ctx.session.auth.current
      );
      const run = await readPipelineRun(target.slug, scope);
      return { found: run !== null, run, success: true as const };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Run read failed.",
        found: false,
        run: null,
        success: false as const,
      };
    }
  },
  inputSchema: z.object({
    repository: z.string().min(3).max(220),
    scope: pipelineScopeSchema,
  }),
});

/**
 * Absent from a lane with no repository selected and no factory path open to
 * it. `agent/lib/repository-lane.ts` owns the decision and the reasoning; it
 * gates the catalog only, never authorization, and the resolver re-runs each
 * turn so a later message naming a repository restores the tool. The tool
 * itself is the same object either way, so its callbacks keep the durable
 * descriptors eve stamped on the `defineTool` call above.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      repositoryCapabilitiesAvailable(ctx.session.auth.current)
        ? readPipelineRunTool
        : null,
  },
});
