import type { SessionAuthContext } from "eve/context";

export const SUPPORT_MAX_STEPS = 150;
export const SUPPORT_RUN_MS = 18 * 60_000;

/** Epoch ms stamped by `supportAuth`; a missing or malformed stamp reads as NaN and fails closed. */
export const supportDeadline = (
  auth: SessionAuthContext | null | undefined
): number => {
  const raw = auth?.attributes?.deadline;
  return typeof raw === "string" ? Number(raw) : Number.NaN;
};

export const supportRunBoundReached = ({
  deadline,
  now,
  stepIndex,
}: {
  deadline: number;
  now: number;
  stepIndex: number;
}): boolean =>
  stepIndex >= SUPPORT_MAX_STEPS ||
  !Number.isFinite(deadline) ||
  now >= deadline;
