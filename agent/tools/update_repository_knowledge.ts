import { defineTool } from "eve/tools";
import { z } from "zod";
import { writeDocument } from "#lib/blob.js";
import { repositoryKnowledgePolicy } from "#lib/github/approval.js";
import { resolveRepositoryInput } from "#lib/repository.js";
import {
  MAX_REPOSITORY_KNOWLEDGE_LENGTH,
  repositoryKnowledgeKey,
} from "#lib/repository-knowledge.js";

export default defineTool({
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
