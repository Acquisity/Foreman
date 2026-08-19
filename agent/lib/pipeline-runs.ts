import { list } from "@vercel/blob";
import { z } from "zod";
import { PIPELINE_RUNS_PREFIX, readDocument, writeDocument } from "./blob.js";
import { repositoryHash } from "./repository.js";

export const pipelineStageSchema = z.enum([
  "intake",
  "classified",
  "investigated",
  "planned",
  "implemented",
  "reviewed",
  "pull_request",
  "stabilizing",
  "ready",
  "escalated",
]);

export const pipelineRunSchema = z.object({
  actionableFeedbackRemaining: z.boolean().default(true),
  blockerRepeatCount: z.number().int().min(0).default(0),
  blockers: z.array(z.string()).default([]),
  checksPassed: z.boolean().default(false),
  headSha: z.string().nullable().default(null),
  internalApproved: z.boolean().default(false),
  linearIssueId: z.string().nullable().default(null),
  linearSessionId: z.string().nullable().default(null),
  mergeable: z.boolean().default(false),
  owner: z.string(),
  prNumber: z.number().int().positive().nullable().default(null),
  processedFeedback: z.array(z.string()).default([]),
  repo: z.string(),
  repository: z.string(),
  scope: z.string(),
  stage: pipelineStageSchema,
  status: z.enum(["active", "ready", "escalated"]).default("active"),
  updatedAt: z.string(),
});

export type PipelineRun = z.infer<typeof pipelineRunSchema>;

const PIPELINE_SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;

export const isStalePipelineEvent = (
  currentHeadSha: string | null | undefined,
  eventHeadSha: string | null | undefined
): boolean =>
  Boolean(currentHeadSha && eventHeadSha && currentHeadSha !== eventHeadSha);

export const mergeFeedbackIds = (
  existing: readonly string[],
  incoming: readonly string[]
): string[] => [...new Set([...existing, ...incoming])];

export const nextBlockerRepeatCount = (
  previousBlockers: readonly string[],
  previousCount: number,
  suppliedBlockers: readonly string[] | undefined
): number => {
  if (suppliedBlockers === undefined) {
    return previousCount;
  }
  if (suppliedBlockers.length === 0) {
    return 0;
  }
  const normalize = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
      (left, right) => left.localeCompare(right)
    );
  return JSON.stringify(normalize(previousBlockers)) ===
    JSON.stringify(normalize(suppliedBlockers))
    ? previousCount + 1
    : 1;
};

export const isPipelineReady = (input: {
  actionableFeedbackRemaining: boolean;
  blockers: readonly string[];
  checksPassed: boolean;
  internalApproved: boolean;
  mergeable: boolean;
  requested: boolean;
}): boolean =>
  input.requested &&
  input.internalApproved &&
  input.checksPassed &&
  input.mergeable &&
  !input.actionableFeedbackRemaining &&
  input.blockers.length === 0;

const scopeKey = (scope: string): string => {
  if (!PIPELINE_SCOPE_PATTERN.test(scope)) {
    throw new Error("Pipeline scope is invalid.");
  }
  return Buffer.from(scope).toString("base64url");
};

export const pipelineRunKey = (repository: string, scope: string): string =>
  `${PIPELINE_RUNS_PREFIX}${repositoryHash(repository)}/${scopeKey(scope)}.json`;

export const readPipelineRun = async (
  repository: string,
  scope: string
): Promise<PipelineRun | null> => {
  const doc = await readDocument(pipelineRunKey(repository, scope));
  return doc.found ? pipelineRunSchema.parse(JSON.parse(doc.content)) : null;
};

export const writePipelineRun = async (run: PipelineRun): Promise<void> => {
  await writeDocument(
    pipelineRunKey(run.repository, run.scope),
    JSON.stringify(run, null, 2),
    { allowOverwrite: true, contentType: "application/json" }
  );
};

export const listActivePipelineRuns = async (): Promise<PipelineRun[]> => {
  const listAll = async (
    cursor?: string,
    previous: Awaited<ReturnType<typeof list>>["blobs"] = []
  ): Promise<Awaited<ReturnType<typeof list>>["blobs"]> => {
    const page = await list({ cursor, prefix: PIPELINE_RUNS_PREFIX });
    const combined = [...previous, ...page.blobs];
    return page.hasMore ? listAll(page.cursor, combined) : combined;
  };
  const blobs = await listAll();
  const runs = await Promise.all(
    blobs.map(async (blob) => {
      const doc = await readDocument(blob.pathname);
      if (!doc.found) {
        return null;
      }
      try {
        return pipelineRunSchema.parse(JSON.parse(doc.content));
      } catch {
        return null;
      }
    })
  );
  return runs.filter(
    (run): run is PipelineRun => run !== null && run.status === "active"
  );
};
