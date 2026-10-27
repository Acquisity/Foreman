import type { SessionAuthContext } from "eve/context";

export const TRIAGE_REPLAY_CASE_ATTRIBUTE = "triageReplayCase";
export const TRIAGE_REPLAY_RUN_ATTRIBUTE = "triageReplayRun";

export const isTriageReplay = (env: NodeJS.ProcessEnv = process.env) =>
  env.TRIAGE_REPLAY === "1";

export function assertTriageReplayAllowed(
  env: NodeJS.ProcessEnv = process.env
) {
  if (!isTriageReplay(env)) {
    return;
  }
  const conflicts = [
    env.VERCEL_ENV === "production" && "VERCEL_ENV=production",
    Boolean(env.FOREMAN_MEMORY_DATABASE_URL) && "FOREMAN_MEMORY_DATABASE_URL",
    Boolean(env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID) &&
      "VERCEL_SANDBOX_BASE_SNAPSHOT_ID",
  ].filter(Boolean);
  if (conflicts.length > 0) {
    throw new Error(`Triage replay cannot run with ${conflicts.join(", ")}.`);
  }
}

export function replaySessionOf(
  auth: SessionAuthContext | null | undefined
): { caseKey: string; runId: string } | null {
  if (!(isTriageReplay() && auth)) {
    return null;
  }
  const caseKey = auth.attributes[TRIAGE_REPLAY_CASE_ATTRIBUTE];
  const runId = auth.attributes[TRIAGE_REPLAY_RUN_ATTRIBUTE];
  return typeof caseKey === "string" && typeof runId === "string"
    ? { caseKey, runId }
    : null;
}

assertTriageReplayAllowed();
