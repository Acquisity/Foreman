import { defineHook } from "eve/hooks";
import { logOpsEvent } from "../ops-log.js";
import { criticVerdictFields } from "../triage-log.js";
import { withReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";
import type { ReplayState } from "./store.js";
import { replayMayCall, replayOutputIsGenerated } from "./tool-policy.js";

/** Model steps one replay session may take before the hook cancels its turn. */
export const replayMaxSteps = (env: NodeJS.ProcessEnv = process.env) =>
  Number(env.TRIAGE_REPLAY_MAX_STEPS ?? 80);

const AS_OF_CASE_RESULTS = new Set([
  "bash",
  "checkout_commit",
  "find_related_issues",
  "glob",
  "grep",
  "prepare_repository",
  "read_file",
]);

const GENERATED_SUBAGENTS = new Set(["critic"]);

const CLOSED_CONNECTION_TOOLS = new Set([
  "executor__execute",
  "executor__skills",
]);

const DECISION_TOOLS = new Set([
  "decide_billing",
  "decide_triage",
  "route_ticket",
]);

export const UNSEEDED_IMAGE = "unseeded_image";

const MEDIA_KEYS = ["mediaType", "media_type", "mimeType"] as const;
const MAX_MEDIA_DEPTH = 12;

const isBinaryMedia = (mediaType: unknown) =>
  typeof mediaType === "string" &&
  (mediaType.startsWith("image/") || mediaType === "application/pdf");

const carriesMedia = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value !== "object" || depth > MAX_MEDIA_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => carriesMedia(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  return (
    MEDIA_KEYS.some((key) => isBinaryMedia(record[key])) ||
    Object.values(record).some((item) => carriesMedia(item, depth + 1))
  );
};

const isImageResult = (output: unknown) => carriesMedia(output);

const textField = (input: Record<string, unknown> | undefined, key: string) =>
  typeof input?.[key] === "string" ? (input[key] as string) : null;

function settleCall(
  state: ReplayState,
  result: {
    callId: string;
    isError?: boolean;
    output: unknown;
    toolName: string;
  }
) {
  const call = state.calls[result.callId];
  delete state.calls[result.callId];
  if (result.isError) {
    if (result.toolName === "route_ticket") {
      state.routeResults.push({
        issue: textField(call?.input, "issue"),
        routed: false,
      });
    }
    return;
  }
  if (result.toolName === "decide_triage") {
    state.decisions.push({
      issue: textField(call?.input, "identifier"),
      kind: "triage",
      output: result.output,
    });
  } else if (result.toolName === "decide_billing") {
    state.decisions.push({
      issue: textField(call?.input, "issue"),
      kind: "billing",
      output: result.output,
    });
  } else if (result.toolName === "route_ticket") {
    const output = result.output as { routed?: unknown } | null;
    state.routeResults.push({
      issue: textField(call?.input, "issue"),
      routed: output?.routed === true,
    });
  }
}

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
    await withReplayState(session.runId, session.caseId, (state) => {
      state.rootTurn = status;
    });
  };

async function persistOrCancel<T>(
  ctx: { cancel: () => void; session: { id: string } },
  work: () => Promise<T>,
  cancelled = false
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!cancelled) {
      ctx.cancel();
    }
    logOpsEvent("triage_replay.cancelled", {
      code: "state_unavailable",
      sessionId: ctx.session.id,
    });
    throw error;
  }
}

const fullText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const calledInput = (action: {
  input?: unknown;
  toolName?: string;
}): Record<string, unknown> => {
  const raw =
    action.toolName === "eve__tool"
      ? (action.input as { input?: unknown } | undefined)?.input
      : action.input;
  return (raw ?? {}) as Record<string, unknown>;
};

/** The tool or subagent an action asks for; skill loads and remote agents name neither. */
const actionName = (action: {
  input?: unknown;
  kind: string;
  subagentName?: string;
  toolName?: string;
}): string | null => {
  if (action.kind === "subagent-call") {
    return action.subagentName ?? null;
  }
  const target = (action.input as { name?: unknown } | undefined)?.name;
  if (action.toolName === "eve__tool" && typeof target === "string") {
    return target;
  }
  return action.toolName ?? null;
};

/**
 * The replay boundary's session side, mounted on the root, the critic and vision.
 * Outside a replay session every handler returns at once. Inside one it:
 * counts model steps and cancels the turn at the budget; cancels the turn
 * when the model asks for a tool the replay policy doesn't allow, before it
 * records anything, and whenever the store can't be written; keeps every
 * tool, subagent and skill result whole as a run input with its provenance;
 * fails the run on any image or PDF result, whether the bytes sit in the result
 * or only a `mediaType` says eve will load them for the model, because a case
 * seeds no image bytes (only its attachment kinds) and Linear uploads are blocked; and
 * marks the ones that show the case's own moment (the pinned code and the
 * as-of snapshot) with the case's creation time; and records the decisions
 * the scorer reads (the last decide_triage, every route_ticket call, the
 * critic's settled verdict).
 */
export const triageReplayHook = defineHook({
  events: {
    "action.result": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      const { result } = event.data;
      if (!session) {
        return;
      }
      switch (result.kind) {
        case "subagent-result":
          await persistOrCancel(ctx, () =>
            withReplayState(session.runId, session.caseId, (state) => {
              state.inputs.push({
                availableAt: null,
                content: fullText(result.output),
                provenance: GENERATED_SUBAGENTS.has(result.subagentName)
                  ? "generated"
                  : "seeded",
                source: `subagent:${result.subagentName}`,
              });
            })
          );
          return;
        case "load-skill-result":
          await persistOrCancel(ctx, () =>
            withReplayState(session.runId, session.caseId, (state) => {
              state.inputs.push({
                availableAt: null,
                content: fullText(result.output),
                provenance: "seeded",
                source: `skill:${result.name}`,
              });
            })
          );
          return;
        default:
          break;
      }
      const image = !result.isError && isImageResult(result.output);
      if (image) {
        ctx.cancel();
        logOpsEvent("triage_replay.cancelled", {
          code: "unseeded_image",
          sessionId: ctx.session.id,
          tool: result.toolName,
        });
      }
      await persistOrCancel(
        ctx,
        () =>
          withReplayState(session.runId, session.caseId, (state) => {
            const generated = replayOutputIsGenerated(result.toolName);
            state.inputs.push({
              availableAt:
                !generated && AS_OF_CASE_RESULTS.has(result.toolName)
                  ? state.case.createdAt
                  : null,
              content: fullText(result.output),
              provenance: generated ? "generated" : "seeded",
              source: result.toolName,
            });
            if (image) {
              state.cancelled ??= `${UNSEEDED_IMAGE}:${result.toolName}`;
            }
            if (DECISION_TOOLS.has(result.toolName)) {
              settleCall(state, result);
            }
          }),
        image
      );
    },
    "actions.requested": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      if (!session) {
        return;
      }
      const denied: string[] = [];
      const misses: string[] = [];
      const calls: [string, ReplayState["calls"][string]][] = [];
      for (const action of event.data.actions) {
        const name = actionName(action);
        if (name === null) {
          continue;
        }
        if (!replayMayCall(name)) {
          denied.push(name);
        }
        if (CLOSED_CONNECTION_TOOLS.has(name)) {
          misses.push(name);
        }
        if (action.kind === "tool-call" && DECISION_TOOLS.has(name)) {
          calls.push([
            action.callId,
            { input: calledInput(action), tool: name },
          ]);
        }
      }
      if (denied.length > 0) {
        ctx.cancel();
        logOpsEvent("triage_replay.cancelled", {
          code: "denied_tool",
          sessionId: ctx.session.id,
          tool: denied.join(","),
        });
      }
      await persistOrCancel(
        ctx,
        () =>
          withReplayState(session.runId, session.caseId, (state) => {
            for (const [callId, call] of calls) {
              state.calls[callId] = call;
            }
            state.evidenceMisses.push(...misses);
            if (denied.length > 0) {
              state.cancelled = `denied_tool:${denied.join(",")}`;
            }
          }),
        denied.length > 0
      );
    },
    "step.started": async (_event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      if (!session) {
        return;
      }
      const max = replayMaxSteps();
      const steps = await persistOrCancel(ctx, () =>
        withReplayState(session.runId, session.caseId, (state) => {
          state.steps += 1;
          if (state.steps > max) {
            state.cancelled ??= "step_budget";
          }
          return state.steps;
        })
      );
      if (steps > max) {
        ctx.cancel();
        logOpsEvent("triage_replay.cancelled", {
          code: "step_budget",
          sessionId: ctx.session.id,
        });
      }
    },
    "task.settled": async (event, ctx) => {
      const session = replaySessionOf(ctx.session.auth.initiator);
      const { data } = event;
      if (!(session && data.kind === "agent" && data.name === "critic")) {
        return;
      }
      const verdict = criticVerdictFields(
        data.status,
        data.status === "completed" ? data.output : undefined
      );
      await persistOrCancel(ctx, () =>
        withReplayState(session.runId, session.caseId, (state) => {
          state.critic = {
            blockingFindings: verdict.blockingFindings,
            failedCriteria: verdict.failedCriteria,
            verdict: verdict.verdict,
          };
        })
      );
    },
    "turn.cancelled": endRootTurn("cancelled"),
    "turn.completed": endRootTurn("completed"),
    "turn.failed": endRootTurn("failed"),
  },
});
