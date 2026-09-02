import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  isPipelineReady,
  isStalePipelineEvent,
  mergeFeedbackIds,
  nextBlockerRepeatCount,
  type PipelineRun,
  pipelineScopeSchema,
  pipelineStageSchema,
  readPipelineRun,
  withPipelineRunLock,
  writePipelineRun,
} from "#lib/pipeline-runs.js";
import {
  type RepositoryTarget,
  resolveRepositoryInput,
} from "#lib/repository.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";

const inputSchema = z.object({
  actionableFeedbackRemaining: z.boolean().optional(),
  blockers: z.array(z.string().max(500)).max(50).optional(),
  checksPassed: z.boolean().optional(),
  eventHeadSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/iu)
    .nullable()
    .optional(),
  feedbackIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/iu)
    .nullable()
    .optional(),
  internalApproved: z.boolean().optional(),
  linearIssueId: z.string().max(160).nullable().optional(),
  linearSessionId: z.string().max(160).nullable().optional(),
  mergeable: z.boolean().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  repository: z.string().min(3).max(220),
  requestReady: z.boolean().optional(),
  scope: pipelineScopeSchema,
  stage: pipelineStageSchema,
});

type RecordInput = z.infer<typeof inputSchema>;

const normalizeBlockers = (
  blockers: readonly string[] | undefined,
  existing: PipelineRun | null
): string[] =>
  [
    ...new Set(
      (blockers ?? existing?.blockers ?? [])
        .map((blocker) => blocker.trim())
        .filter(Boolean)
    ),
  ].sort((left, right) => left.localeCompare(right));

const nextRepeatCount = (
  supplied: readonly string[] | undefined,
  existing: PipelineRun | null
): number =>
  nextBlockerRepeatCount(
    existing?.blockers ?? [],
    existing?.blockerRepeatCount ?? 0,
    supplied
  );

const terminalState = (
  ready: boolean,
  escalated: boolean,
  requestedStage: RecordInput["stage"]
): Pick<PipelineRun, "stage" | "status"> => {
  if (escalated) {
    return { stage: "escalated", status: "escalated" };
  }
  if (ready) {
    return { stage: "ready", status: "ready" };
  }
  return { stage: requestedStage, status: "active" };
};

const buildRun = (
  input: RecordInput,
  target: RepositoryTarget,
  existing: PipelineRun | null
): PipelineRun => {
  const blockers = normalizeBlockers(input.blockers, existing);
  const blockerRepeatCount = nextRepeatCount(input.blockers, existing);
  const headChanged = Boolean(
    input.headSha && input.headSha !== existing?.headSha
  );
  const internalApproved = headChanged
    ? (input.internalApproved ?? false)
    : (input.internalApproved ?? existing?.internalApproved ?? false);
  const checksPassed = headChanged
    ? (input.checksPassed ?? false)
    : (input.checksPassed ?? existing?.checksPassed ?? false);
  const mergeable = headChanged
    ? (input.mergeable ?? false)
    : (input.mergeable ?? existing?.mergeable ?? false);
  const actionableFeedbackRemaining = headChanged
    ? true
    : (input.actionableFeedbackRemaining ??
      existing?.actionableFeedbackRemaining ??
      true);
  const ready = isPipelineReady({
    actionableFeedbackRemaining,
    blockers,
    checksPassed,
    internalApproved,
    mergeable,
    requested: input.requestReady === true,
  });
  const state = terminalState(ready, blockerRepeatCount >= 3, input.stage);
  return {
    ...state,
    actionableFeedbackRemaining,
    blockerRepeatCount,
    blockers,
    checksPassed,
    headSha: input.headSha ?? existing?.headSha ?? null,
    internalApproved,
    linearIssueId: input.linearIssueId ?? existing?.linearIssueId ?? null,
    linearSessionId: input.linearSessionId ?? existing?.linearSessionId ?? null,
    mergeable,
    owner: target.owner,
    prNumber: input.prNumber ?? existing?.prNumber ?? null,
    processedFeedback: mergeFeedbackIds(
      existing?.processedFeedback ?? [],
      input.feedbackIds ?? []
    ),
    repo: target.repo,
    repository: target.slug,
    scope: input.scope,
    updatedAt: new Date().toISOString(),
  };
};

export const recordPipelineRunTool = defineTool({
  description:
    "Create or advance durable factory pipeline state scoped to a repository and source or pull request. Deduplicates feedback, rejects stale-head events, counts unchanged blocker sets, escalates on the third repeat, and only records readiness when every readiness condition is true.",
  async execute(input, ctx) {
    try {
      const target = resolveRepositoryInput(
        input.repository,
        ctx.session.auth.current
      );
      const normalizedInput = {
        ...input,
        eventHeadSha: input.eventHeadSha?.toLowerCase() ?? input.eventHeadSha,
        headSha: input.headSha?.toLowerCase() ?? input.headSha,
      };
      return await withPipelineRunLock(
        `${target.slug.toLowerCase()}:${input.scope}`,
        async () => {
          const stored = await readPipelineRun(target.slug, input.scope);
          const existing = stored && {
            ...stored,
            headSha: stored.headSha?.toLowerCase() ?? null,
          };
          // The event carries the head this same call is recording, so it is the
          // advance rather than a redelivery of an older one.
          const advancing = Boolean(
            normalizedInput.headSha &&
              normalizedInput.headSha === normalizedInput.eventHeadSha
          );
          if (
            !advancing &&
            isStalePipelineEvent(
              existing?.headSha,
              normalizedInput.eventHeadSha
            )
          ) {
            return {
              currentHeadSha: existing?.headSha ?? null,
              stale: true,
              success: false as const,
            };
          }
          // A redelivered webhook carries feedback this run already processed.
          // Recording it again would count the unchanged blocker set a second
          // time and escalate without a new attempt.
          const redelivered =
            existing !== null &&
            (input.feedbackIds?.length ?? 0) > 0 &&
            (input.feedbackIds ?? []).every((id) =>
              existing.processedFeedback.includes(id)
            );
          if (redelivered) {
            return {
              blockerRepeatCount: existing.blockerRepeatCount,
              duplicate: true,
              processedFeedback: existing.processedFeedback,
              ready: existing.status === "ready",
              run: existing,
              success: true as const,
            };
          }
          const run = buildRun(normalizedInput, target, existing);
          await writePipelineRun(run);
          return {
            blockerRepeatCount: run.blockerRepeatCount,
            processedFeedback: run.processedFeedback,
            ready: run.status === "ready",
            run,
            success: true as const,
          };
        }
      );
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Run update failed.",
        success: false as const,
      };
    }
  },
  inputSchema,
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
        ? recordPipelineRunTool
        : null,
  },
});
