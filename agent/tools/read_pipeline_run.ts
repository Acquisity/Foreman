import { defineTool } from "eve/tools";
import { z } from "zod";
import { pipelineScopeSchema, readPipelineRun } from "#lib/pipeline-runs.js";
import { resolveRepositoryInput } from "#lib/repository.js";

export default defineTool({
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
