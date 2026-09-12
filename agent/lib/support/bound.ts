import type { SessionAuthContext } from "eve/context";

export const SUPPORT_MAX_STEPS = 150;
export const SUPPORT_RUN_MS = 18 * 60_000;

export interface SupportRunSteps {
  count: number;
  stepIndex: number;
  turnId: string | null;
}

/** Root turns run serially; a retried step must not consume its budget twice. */
export const countSupportStep = (
  previous: SupportRunSteps,
  step: { stepIndex: number; turnId: string }
): SupportRunSteps =>
  previous.turnId === step.turnId && step.stepIndex <= previous.stepIndex
    ? previous
    : {
        count: previous.count + 1,
        stepIndex: step.stepIndex,
        turnId: step.turnId,
      };

/** Epoch ms stamped by supportAuth; a malformed stamp fails closed. */
export const supportDeadline = (
  auth: SessionAuthContext | null | undefined
): number => {
  const raw = auth?.attributes?.deadline;
  return typeof raw === "string" ? Number(raw) : Number.NaN;
};

export const supportRunBoundReached = ({
  deadline,
  now,
  steps,
}: {
  deadline: number;
  now: number;
  steps: number;
}): boolean =>
  steps > SUPPORT_MAX_STEPS || !Number.isFinite(deadline) || now >= deadline;
