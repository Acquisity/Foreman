import { defineHook } from "eve/hooks";
import {
  type CriticRounds,
  criticTaskPacket,
  criticVerdictFields,
  reviewCycleAfterDecision,
  settleCriticPacket,
  stampCriticPacket,
} from "../triage-log.js";
import { withReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";
import type { ReplayState } from "./store.js";

const DECISIONS: Record<string, ReplayState["decisions"][number]["kind"]> = {
  decide_billing: "billing",
  decide_triage: "triage",
};

/**
 * Whether live records this decision tool result: decide_triage always does,
 * a failed call as the fallback decision, and decide_billing only when Jev
 * answered.
 */
const recordedLive = (
  kind: ReplayState["decisions"][number]["kind"],
  output: unknown
): boolean =>
  kind === "triage" ||
  (output as { decided?: unknown } | null)?.decided === true;

/** Keeps the replay's objection count in step with the live rounds. */
const withRounds = (
  state: ReplayState,
  rounds: Record<string, CriticRounds>
) => {
  state.criticRounds = rounds;
  state.criticObjections = rounds[state.case.id]?.objections ?? 0;
};

const endRootTurn =
  (status: NonNullable<ReplayState["rootTurn"]>) =>
  async (
    _event: unknown,
    ctx: {
      session: {
        auth: { initiator: Parameters<typeof replaySessionOf>[0] };
        parent?: unknown;
      };
    }
  ) => {
    const session = replaySessionOf(ctx.session.auth.initiator);
    if (!session || ctx.session.parent) {
      return;
    }
    await withReplayState(session.runId, session.caseKey, (state) => {
      state.rootTurn = status;
    });
  };

export const triageReplayHook = defineHook({
  events: {
    "action.result": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      const { result } = event.data;
      if (!session || result.kind !== "tool-result" || result.isError) {
        return;
      }
      const kind = DECISIONS[result.toolName];
      if (!kind) {
        return;
      }
      await withReplayState(session.runId, session.caseKey, (state) => {
        state.decisions.push({ kind, output: result.output });
        if (recordedLive(kind, result.output)) {
          withRounds(
            state,
            reviewCycleAfterDecision(state.criticRounds ?? {}, state.case.id)
          );
        }
      });
    },
    "actions.requested": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      if (!session) {
        return;
      }
      const packets = event.data.actions.flatMap((action) => {
        const packet =
          action.kind === "subagent-call" && action.subagentName === "critic"
            ? criticTaskPacket(action.input)
            : null;
        return packet ? [[action.callId, packet] as const] : [];
      });
      if (packets.length === 0) {
        return;
      }
      await withReplayState(session.runId, session.caseKey, (state) => {
        const { generation } = stampCriticPacket(state.criticRounds ?? {}, {
          commit: null,
          documentId: null,
          issue: state.case.id,
          updatedAt: null,
        });
        state.criticPackets = {
          ...state.criticPackets,
          ...Object.fromEntries(
            packets.map(([callId, packet]) => [
              callId,
              { ...packet, generation },
            ])
          ),
        };
      });
    },
    "task.settled": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      const { data } = event;
      if (!(session && data.kind === "agent" && data.name === "critic")) {
        return;
      }
      await withReplayState(session.runId, session.caseKey, (state) => {
        if (state.criticCalls?.includes(data.callId)) {
          return;
        }
        state.criticCalls = [...(state.criticCalls ?? []), data.callId];
        const packet = state.criticPackets?.[data.callId] ?? null;
        const critic = criticVerdictFields(
          data.status,
          data.status === "completed" ? data.output : undefined,
          packet
        );
        const rounds = state.criticRounds ?? {};
        const settled = settleCriticPacket(
          rounds,
          packet
            ? { ...packet, issue: state.case.id }
            : stampCriticPacket(rounds, {
                commit: null,
                documentId: null,
                issue: state.case.id,
                updatedAt: null,
              }),
          critic.counted
        );
        if (settled.stale) {
          return;
        }
        state.critic = critic;
        withRounds(state, settled.rounds);
      });
    },
    "turn.cancelled": endRootTurn("cancelled"),
    "turn.completed": endRootTurn("completed"),
    "turn.failed": endRootTurn("failed"),
  },
});
