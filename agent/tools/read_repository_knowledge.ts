import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readDocument } from "#lib/blob.js";
import { resolveRepositoryInput } from "#lib/repository.js";
import {
  legacyFactoryBrainKey,
  repositoryKnowledgeKey,
} from "#lib/repository-knowledge.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";

export const readRepositoryKnowledgeTool = defineTool({
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
        ? readRepositoryKnowledgeTool
        : null,
  },
});
