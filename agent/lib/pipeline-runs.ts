import { del, list } from "@vercel/blob";
import { z } from "zod";
import {
  ACTIVE_PIPELINE_RUNS_PREFIX,
  PIPELINE_RUNS_PREFIX,
  readDocument,
  writeDocument,
} from "./blob.js";
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
  merged: z.boolean().default(false),
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

// Both pipeline tools validate the scope the same way, so a run that can be
// written is always readable through its companion tool.
export const pipelineScopeSchema = z.string().regex(PIPELINE_SCOPE_PATTERN);

export const isStalePipelineEvent = (
  currentHeadSha: string | null | undefined,
  eventHeadSha: string | null | undefined
): boolean =>
  Boolean(currentHeadSha && (!eventHeadSha || currentHeadSha !== eventHeadSha));

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

/**
 * Resolves a pipeline run's terminal {@link PipelineRun.stage} and
 * {@link PipelineRun.status} from its readiness, escalation, and merge state.
 *
 * @remarks
 * Only `active` runs are recovered by the reconciliation schedule, so a run
 * reaches a stable, non-recovered state only when this returns a status other
 * than `active`. Three forces can end a run:
 *
 * - `merged`: the pull request was merged, so the run is delivered and
 *   terminal whether or not the independent reviewer certified the head. This
 *   is the path a run takes when a human merges a pull request the factory was
 *   still stabilizing; without it the run stays `active` and the reconcile
 *   schedule recovers it every tick forever. `merged` is sticky: once a run is
 *   merged it is terminal for good, so a later record (for example a comment
 *   on the merged pull request) cannot reactivate it.
 * - `escalated`: the same blocker set repeated three times, so a person must
 *   intervene.
 * - `ready`: every readiness condition held and readiness was requested.
 *
 * Merge takes precedence over escalation and readiness: a merged pull request is
 * delivered, and `ready` is the honest terminal for it. The escalation history
 * (blocker set and repeat count) is preserved on the run regardless.
 *
 * @param ready - Whether every readiness condition held and was requested.
 * @param escalated - Whether the blocker set repeated three times.
 * @param merged - Whether the pull request was merged.
 * @param requestedStage - The stage the caller asked to record.
 * @returns The terminal stage and status for the run.
 */
export const terminalPipelineState = (
  ready: boolean,
  escalated: boolean,
  merged: boolean,
  requestedStage: PipelineRun["stage"]
): Pick<PipelineRun, "stage" | "status"> => {
  if (merged) {
    return { stage: "ready", status: "ready" };
  }
  if (escalated) {
    return { stage: "escalated", status: "escalated" };
  }
  if (ready) {
    return { stage: "ready", status: "ready" };
  }
  return { stage: requestedStage, status: "active" };
};

const scopeKey = (scope: string): string => {
  if (!PIPELINE_SCOPE_PATTERN.test(scope)) {
    throw new Error("Pipeline scope is invalid.");
  }
  return Buffer.from(scope).toString("base64url");
};

export const pipelineRunKey = (repository: string, scope: string): string =>
  `${PIPELINE_RUNS_PREFIX}${repositoryHash(repository)}/${scopeKey(scope)}.json`;

const activePipelineRunKey = (repository: string, scope: string): string =>
  `${ACTIVE_PIPELINE_RUNS_PREFIX}${repositoryHash(repository)}/${scopeKey(scope)}.json`;

const runLocks = new Map<string, Promise<void>>();
export const withPipelineRunLock = async <T>(
  key: string,
  task: () => Promise<T>
): Promise<T> => {
  const previous = runLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  runLocks.set(key, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (runLocks.get(key) === queued) {
      runLocks.delete(key);
    }
  }
};

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
  const activeKey = activePipelineRunKey(run.repository, run.scope);
  if (run.status === "active") {
    await writeDocument(activeKey, JSON.stringify(run, null, 2), {
      allowOverwrite: true,
      contentType: "application/json",
    });
  } else {
    await del(activeKey);
  }
};

export const listActivePipelineRuns = async (): Promise<PipelineRun[]> => {
  const listAll = async (
    cursor?: string,
    previous: Awaited<ReturnType<typeof list>>["blobs"] = []
  ): Promise<Awaited<ReturnType<typeof list>>["blobs"]> => {
    const page = await list({ cursor, prefix: ACTIVE_PIPELINE_RUNS_PREFIX });
    const combined = [...previous, ...page.blobs];
    return page.hasMore ? listAll(page.cursor, combined) : combined;
  };
  const blobs = await listAll();
  const results = await Promise.allSettled(
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
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value?.status === "active"
      ? [result.value]
      : []
  );
};
