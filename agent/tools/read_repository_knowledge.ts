import { defineTool } from "eve/tools";
import { z } from "zod";
import { readDocument } from "#lib/blob.js";
import { resolveRepositoryInput } from "#lib/repository.js";
import {
  legacyFactoryBrainKey,
  repositoryKnowledgeKey,
} from "#lib/repository-knowledge.js";

export default defineTool({
  description:
    "Read verified, durable knowledge for one explicitly selected repository. Falls back to that repository's legacy factory-brain document only when no new knowledge document exists.",
  async execute({ repository }, ctx) {
    try {
      const target = resolveRepositoryInput(
        repository,
        ctx.session.auth.current
      );
      const current = await readDocument(repositoryKnowledgeKey(target.slug));
      if (current.found) {
        return {
          found: true,
          knowledge: current.content,
          legacy: false,
          repository: target.slug,
        };
      }
      const legacy = await readDocument(legacyFactoryBrainKey(target.slug));
      return legacy.found
        ? {
            found: true,
            knowledge: legacy.content,
            legacy: true,
            repository: target.slug,
          }
        : {
            found: false,
            knowledge: "",
            legacy: false,
            repository: target.slug,
          };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Read failed.",
        found: false,
        knowledge: "",
        legacy: false,
        repository: null,
      };
    }
  },
  inputSchema: z.object({ repository: z.string().min(3).max(220) }),
});
