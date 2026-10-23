import type { SessionAuthContext } from "eve/context";
import type { ProviderClient } from "../executor/operations.js";
import type { LinearOperation } from "../linear-operations.js";
import { withReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";
import { answerLinear } from "./store.js";

/**
 * The typed Executor client inside a replay session: authored Linear
 * operations answer from the simulated store, and every other provider read
 * (PlanetScale, Sentry, Stripe, Autumn, Instantly, Inngest, help center)
 * fails closed with a 503 and is recorded as an evidence miss. Nothing
 * reaches the Executor transport.
 */
export function replayProviderClient(
  auth: SessionAuthContext | null | undefined
): ProviderClient {
  const session = replaySessionOf(auth);
  if (!session) {
    throw new Error("A replay client needs a replay session.");
  }
  return async (request) => {
    const { operation } = request;
    if (operation.startsWith("linear.")) {
      const name = operation.slice(7) as LinearOperation;
      const { variables } = request.input as {
        variables: Record<string, unknown>;
      };
      const answer = await withReplayState(
        session.runId,
        session.caseId,
        (state) => {
          const result = answerLinear(state, name, variables);
          state.inputs.push({
            availableAt:
              result.provenance === "seeded" ? state.case.createdAt : null,
            content: JSON.stringify(result.data),
            provenance: result.provenance,
            source: operation,
          });
          return result;
        }
      );
      return { data: { data: answer.data }, status: 200 };
    }
    await withReplayState(session.runId, session.caseId, (state) => {
      state.evidenceMisses.push(operation);
    });
    return { data: null, status: 503 };
  };
}

export async function recordReplayEvidenceMiss(
  auth: SessionAuthContext | null | undefined,
  operation: string
) {
  const session = replaySessionOf(auth);
  if (!session) {
    return;
  }
  await withReplayState(session.runId, session.caseId, (state) => {
    state.evidenceMisses.push(operation);
  });
}

export async function recordReplayReply(
  auth: SessionAuthContext | null | undefined,
  issue: string,
  message: string
) {
  const session = replaySessionOf(auth);
  if (!session) {
    throw new Error("A replay reply needs a replay session.");
  }
  await withReplayState(session.runId, session.caseId, (state) => {
    state.replies.push({ issue, message });
  });
  return {
    commentId: `replay-reply-${issue}`,
    posted: true as const,
    url: `https://linear.app/acquisity/issue/${issue}/replay`,
  };
}

export async function recordReplayMemory(
  auth: SessionAuthContext | null | undefined,
  payload: unknown
) {
  const session = replaySessionOf(auth);
  if (!session) {
    throw new Error("A replay memory write needs a replay session.");
  }
  const count = await withReplayState(
    session.runId,
    session.caseId,
    (state) => {
      state.memory.push(payload);
      return state.memory.length;
    }
  );
  return {
    caseId: `replay-memory-${count}`,
    recorded: true as const,
    revision: 1,
  };
}
