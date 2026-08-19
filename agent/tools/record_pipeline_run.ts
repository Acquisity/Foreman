import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  isPipelineReady,
  isStalePipelineEvent,
  mergeFeedbackIds,
  nextBlockerRepeatCount,
  type PipelineRun,
  pipelineStageSchema,
  readPipelineRun,
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
  eventHeadSha: z.string().length(40).nullable().optional(),
  feedbackIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  headSha: z.string().length(40).nullable().optional(),
  internalApproved: z.boolean().optional(),
  linearIssueId: z.string().max(160).nullable().optional(),
  linearSessionId: z.string().max(160).nullable().optional(),
  mergeable: z.boolean().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  repository: z.string().min(3).max(220),
  requestReady: z.boolean().optional(),
  scope: z.string().min(1).max(160),
  stage: pipelineStageSchema,
});

type RecordInput = z.infer<typeof inputSchema>;

const normalizeBlockers = (
  blockers: readonly string[] | undefined,
  existing: PipelineRun | null
): string[] =>
  [...new Set(blockers ?? existing?.blockers ?? [])]
    .map((blocker) => blocker.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

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
  const internalApproved =
    input.internalApproved ?? existing?.internalApproved ?? false;
  const checksPassed = input.checksPassed ?? existing?.checksPassed ?? false;
  const mergeable = input.mergeable ?? existing?.mergeable ?? false;
  const actionableFeedbackRemaining =
    input.actionableFeedbackRemaining ??
    existing?.actionableFeedbackRemaining ??
    true;
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

export default defineTool({
  description:
    "Create or advance durable factory pipeline state scoped to a repository and source or pull request. Deduplicates feedback, rejects stale-head events, counts unchanged blocker sets, escalates on the third repeat, and only records readiness when every readiness condition is true.",
  async execute(input, ctx) {
    try {
      const target = resolveRepositoryInput(
        input.repository,
        ctx.session.auth.current
      );
      const existing = await readPipelineRun(target.slug, input.scope);
      if (isStalePipelineEvent(existing?.headSha, input.eventHeadSha)) {
        return {
          currentHeadSha: existing?.headSha ?? null,
          stale: true,
          success: false as const,
        };
      }
      const run = buildRun(input, target, existing);
      await writePipelineRun(run);
      return {
        blockerRepeatCount: run.blockerRepeatCount,
        processedFeedback: run.processedFeedback,
        ready: run.status === "ready",
        run,
        success: true as const,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Run update failed.",
        success: false as const,
      };
    }
  },
  inputSchema,
});
