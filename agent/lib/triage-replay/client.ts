import type { SessionAuthContext } from "eve/context";
import type { ProviderClient } from "../executor/operations.js";
import {
  LINEAR_OPERATIONS,
  type LinearOperation,
} from "../linear-operations.js";
import { readReplayState, withReplayState } from "./backend.js";
import { answerLinear } from "./linear-simulation.js";
import { replaySessionOf } from "./mode.js";
import { urlOf } from "./store.js";

export function replayProviderClient(
  auth: SessionAuthContext | null | undefined
): ProviderClient {
  const session = replaySessionOf(auth);
  if (!session) {
    throw new Error("A replay client needs a replay session.");
  }
  const { caseKey, runId } = session;
  return async ({ input, operation }) => {
    if (!operation.startsWith("linear.")) {
      await withReplayState(runId, caseKey, (state) => {
        state.evidenceMisses.push(operation);
      });
      return { data: null, status: 503 };
    }
    const name = operation.slice(7) as LinearOperation;
    const { variables } = input as { variables: Record<string, unknown> };
    const data =
      LINEAR_OPERATIONS[name]?.kind === "mutation"
        ? await withReplayState(runId, caseKey, (state) =>
            answerLinear(state, name, variables)
          )
        : answerLinear(await readReplayState(runId, caseKey), name, variables);
    return { data: { data }, status: 200 };
  };
}

export function replayReply(
  auth: SessionAuthContext | null | undefined,
  issue: string
) {
  return replaySessionOf(auth)
    ? {
        commentId: `replay-reply-${issue}`,
        posted: true as const,
        url: urlOf(issue),
      }
    : null;
}
