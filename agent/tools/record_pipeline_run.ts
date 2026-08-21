import { defineTool } from "eve/tools";
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
  terminalPipelineState,
  withPipelineRunLock,
  writePipelineRun,
} from "#lib/pipeline-runs.js";
import {
  type RepositoryTarget,
  resolveRepositoryInput,
} from "#lib/repository.js";

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
  merged: z.boolean().optional(),
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
  // Merged is sticky: once a pull request is merged the run is terminal for
  // good, so a later record that omits `merged` (for example a comment on the
  // merged pull request) cannot reactivate it and re-arm the reconcile loop.
  const merged = input.merged === true || existing?.merged === true;
  const ready = isPipelineReady({
    actionableFeedbackRemaining,
    blockers,
    checksPassed,
    internalApproved,
    mergeable,
    requested: input.requestReady === true,
  });
  const state = terminalPipelineState(
    ready,
    blockerRepeatCount >= 3,
    merged,
    input.stage
  );
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
    merged,
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

export default defineTool({
  description:
    "Create or advance durable factory pipeline state scoped to a repository and source or pull request. Deduplicates feedback, rejects stale-head events, counts unchanged blocker sets, escalates on the third repeat, marks the run terminal when the pull request is merged, and only records readiness when every readiness condition is true.",
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
            merged: run.merged,
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
