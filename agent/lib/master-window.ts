import type { SessionAuthContext } from "eve/context";
import { readReplayState } from "./triage-replay/backend.js";
import { replaySessionOf } from "./triage-replay/mode.js";
import { isIntakeOnly, isLinearSession } from "./trust.js";

/**
 * Whether this session's master search is limited to recent masters, and the
 * time it counts from: an intake-only Slack session, a Linear session, and a
 * triage replay (at the case's creation time) are windowed. find_related_issues
 * searches with it and route_ticket parents duplicates with it, so a master
 * the search would not offer is never attached either.
 */
export async function masterWindow(auth: {
  current: SessionAuthContext | null;
  initiator: SessionAuthContext | null | undefined;
}): Promise<{ now?: Date; windowed: boolean }> {
  const replay = replaySessionOf(auth.initiator);
  const now = replay
    ? new Date(
        (await readReplayState(replay.runId, replay.caseKey)).case.createdAt
      )
    : undefined;
  return {
    now,
    windowed:
      replay !== null ||
      isIntakeOnly(auth.current) ||
      isLinearSession(auth.current),
  };
}
