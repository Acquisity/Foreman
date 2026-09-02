import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { writeDocument } from "#lib/blob.js";
import { repositoryKnowledgePolicy } from "#lib/github/approval.js";
import { resolveRepositoryInput } from "#lib/repository.js";
import {
  MAX_REPOSITORY_KNOWLEDGE_LENGTH,
  repositoryKnowledgeKey,
} from "#lib/repository-knowledge.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";

export const updateRepositoryKnowledgeTool = defineTool({
  approval: repositoryKnowledgePolicy,
  description:
    "Overwrite the verified knowledge document for one selected repository. Read and merge first. A write always targets the new repository-knowledge namespace. Any legacy factory-brain document is left in place and is no longer read once this document exists.",
  async execute({ knowledge, repository }, ctx) {
    try {
      const target = resolveRepositoryInput(
        repository,
        ctx.session.auth.current
      );
      const blob = await writeDocument(
        repositoryKnowledgeKey(target.slug),
        knowledge,
        { allowOverwrite: true }
      );
      return {
        pathname: blob.pathname,
        repository: target.slug,
        success: true as const,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Write failed.",
        success: false as const,
      };
    }
  },
  inputSchema: z.object({
    knowledge: z.string().min(1).max(MAX_REPOSITORY_KNOWLEDGE_LENGTH),
    repository: z.string().min(3).max(220),
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
        ? updateRepositoryKnowledgeTool
        : null,
  },
});
