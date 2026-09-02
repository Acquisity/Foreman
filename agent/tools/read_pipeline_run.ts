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
 * gates the catalog only, never authorization. The resolver runs at
 * `step.started`, the same event the GitHub surface it is gated alongside
 * runs at, because eve resolves `turn.started` once before the turn's first
 * tool runs: a repository `prepare_repository` selects mid-turn has to
 * restore this tool on the next step of that same turn, not only on the next
 * message. The tool itself is the same object either way, so its callbacks
 * keep the durable descriptors eve stamped on the `defineTool` call above.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      repositoryCapabilitiesAvailable(ctx.session.auth.current)
        ? readPipelineRunTool
        : null,
  },
});
