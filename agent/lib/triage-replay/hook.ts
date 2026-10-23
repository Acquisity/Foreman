import { defineHook } from "eve/hooks";
import { criticVerdictFields, nextObjections } from "../triage-log.js";
import { withReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";
import type { ReplayState } from "./store.js";

const DECISIONS: Record<string, ReplayState["decisions"][number]["kind"]> = {
  decide_billing: "billing",
  decide_triage: "triage",
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
      });
    },
    "task.settled": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      const { data } = event;
      if (!(session && data.kind === "agent" && data.name === "critic")) {
        return;
      }
      const critic = criticVerdictFields(
        data.status,
        data.status === "completed" ? data.output : undefined
      );
      await withReplayState(session.runId, session.caseKey, (state) => {
        state.critic = critic;
        state.criticObjections = nextObjections(
          state.criticObjections ?? 0,
          critic.verdict
        );
      });
    },
    "turn.cancelled": endRootTurn("cancelled"),
    "turn.completed": endRootTurn("completed"),
    "turn.failed": endRootTurn("failed"),
  },
});
