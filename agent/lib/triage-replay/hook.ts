import { defineHook } from "eve/hooks";
import {
  criticTaskPacket,
  criticVerdictFields,
  nextObjections,
} from "../triage-log.js";
import { withReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";
import type { ReplayState } from "./store.js";

const DECISIONS: Record<string, ReplayState["decisions"][number]["kind"]> = {
  decide_billing: "billing",
  decide_triage: "triage",
};

/** The live rule: only a decision that was made advances the generation. */
const decisionGeneration = (state: ReplayState): number =>
  state.decisions.filter(
    (entry) => (entry.output as { decided?: unknown } | null)?.decided === true
  ).length;

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
        const generation = decisionGeneration(state);
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
        if (packet && packet.generation !== decisionGeneration(state)) {
          return;
        }
        const critic = criticVerdictFields(
          data.status,
          data.status === "completed" ? data.output : undefined,
          packet
        );
        state.critic = critic;
        state.criticObjections = nextObjections(
          state.criticObjections ?? 0,
          critic.counted
        );
      });
    },
    "turn.cancelled": endRootTurn("cancelled"),
    "turn.completed": endRootTurn("completed"),
    "turn.failed": endRootTurn("failed"),
  },
});
