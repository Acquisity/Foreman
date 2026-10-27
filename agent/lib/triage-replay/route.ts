import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { diagnosticsSecretRefusal } from "../diagnostics-secret.js";
import { BILLING_PATH } from "../triage-log.js";
import { stampTriageIntake, stampUnattended } from "../trust.js";
import { loadReplayState, seedReplayStore } from "./backend.js";
import {
  isTriageReplay,
  TRIAGE_REPLAY_CASE_ATTRIBUTE,
  TRIAGE_REPLAY_RUN_ATTRIBUTE,
} from "./mode.js";
import {
  type TriageResult,
  triageCaseSchema,
  UNKNOWN_COMMIT,
} from "./schema.js";
import {
  frozenListsSchema,
  type ReplayState,
  seedReplayState,
} from "./store.js";
import { appliedRoute } from "./views.js";

export const REPLAY_SECRET_HEADER = "x-foreman-diagnostics-secret";

export const startRequestSchema = z.strictObject({
  archiveUrl: z.url(),
  case: triageCaseSchema,
  lists: frozenListsSchema,
  run: z.int().positive(),
  runId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/),
});
export type StartRequest = z.infer<typeof startRequestSchema>;

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "cache-control": "no-store" }, status });

export const replayRefusal = (
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): Response | null =>
  diagnosticsSecretRefusal(
    request,
    {
      enabled: isTriageReplay(env),
      forbidden: "Forbidden.",
      header: REPLAY_SECRET_HEADER,
      notConfigured: "Replay is not configured.",
    },
    env
  );

export function replayAuth(runId: string, caseKey: string): SessionAuthContext {
  return stampUnattended(
    stampTriageIntake({
      attributes: {
        [TRIAGE_REPLAY_CASE_ATTRIBUTE]: caseKey,
        [TRIAGE_REPLAY_RUN_ATTRIBUTE]: runId,
      },
      authenticator: "bearer",
      issuer: "foreman-triage-replay",
      principalId: `triage-replay:${runId}`,
      principalType: "service",
    })
  );
}

export function replayMessage(request: StartRequest): string {
  const { ticket } = request.case;
  const attachments =
    ticket.attachmentKinds.length > 0
      ? `\n\nAttachments: ${ticket.attachmentKinds.join(", ")}.`
      : "";
  return `Triage ${request.case.id}, delegated to you in Linear.\n\n${request.case.id}: ${ticket.title}\n\n${ticket.description}${attachments}`;
}

export const caseKeyOf = (request: { case: { id: string }; run: number }) =>
  `${request.case.id}#${request.run}`;

const started = new Set<string>();

export const maxRuns = (env: NodeJS.ProcessEnv = process.env) =>
  Number(env.TRIAGE_REPLAY_MAX_RUNS ?? 3);

export async function startReplay(
  request: Request,
  args: {
    from: (address: string) => {
      send: (
        message: string,
        options: { auth: SessionAuthContext }
      ) => Promise<{ id: string }>;
    };
  }
): Promise<Response> {
  const refusal = replayRefusal(request);
  if (refusal) {
    return refusal;
  }
  const parsed = startRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return json({ error: "Invalid replay start request." }, 400);
  }
  const start = parsed.data;
  const key = caseKeyOf(start);
  if (started.size >= maxRuns()) {
    return json(
      { error: `This server has started its ${maxRuns()} replays.` },
      429
    );
  }
  if (
    started.has(`${start.runId}/${key}`) ||
    (await loadReplayState(start.runId, key))
  ) {
    return json({ error: `${key} was already started in this run.` }, 409);
  }
  started.add(`${start.runId}/${key}`);
  await seedReplayStore(
    seedReplayState(start.case, {
      archiveUrl: start.archiveUrl,
      caseKey: key,
      lists: start.lists,
      stamp: {
        foremanCommit:
          process.env.TRIAGE_REPLAY_COMMIT?.trim() ||
          process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
          UNKNOWN_COMMIT,
        startedAt: new Date().toISOString(),
      },
    }),
    start.runId
  );
  const session = await args
    .from(`triage-replay:${start.runId}:${key}`)
    .send(replayMessage(start), { auth: replayAuth(start.runId, key) });
  return json({ caseKey: key, sessionId: session.id });
}

export async function replayResultResponse(
  request: Request
): Promise<Response> {
  const refusal = replayRefusal(request);
  if (refusal) {
    return refusal;
  }
  const url = new URL(request.url);
  const caseKey = url.searchParams.get("caseKey") ?? "";
  const runId = url.searchParams.get("runId") ?? "";
  const state = await loadReplayState(runId, caseKey);
  return state
    ? json({
        result: buildReplayResult(state, runId),
        settled: replaySettled(state),
      })
    : json({ error: "No such replay." }, 404);
}

const triageDecisionSchema = z.object({
  decided: z.literal(true),
  decision: z.union([
    z.object({ outcome: z.literal("unproven") }),
    z.object({
      classification: z.string(),
      hotlane: z.object({ route: z.string() }).optional(),
      needsCriticReview: z.boolean(),
      outcome: z.literal("route"),
      path: z.string(),
    }),
  ]),
});

const billingDecisionSchema = z.object({
  decided: z.literal(true),
  decision: z.object({ route: z.object({ project: z.string() }) }),
});

type FinalDecision =
  | { kind: "billing" }
  | { kind: "unproven" }
  | {
      classification: string;
      kind: "route";
      needsCritic: boolean;
      path: string;
    };

function finalDecision(state: ReplayState): FinalDecision | null {
  for (const entry of [...state.decisions].reverse()) {
    if (entry.kind === "billing") {
      if (billingDecisionSchema.safeParse(entry.output).success) {
        return { kind: "billing" };
      }
      continue;
    }
    const parsed = triageDecisionSchema.safeParse(entry.output);
    if (!parsed.success) {
      continue;
    }
    const { decision } = parsed.data;
    if (decision.outcome === "unproven") {
      return { kind: "unproven" };
    }
    return {
      classification: decision.classification,
      kind: "route",
      needsCritic:
        decision.needsCriticReview &&
        decision.hotlane?.route !== "NEEDS_HUMAN_URGENT",
      path: decision.path,
    };
  }
  return null;
}

function reachedTerminal(state: ReplayState, decision: FinalDecision | null) {
  const routed = appliedRoute(state).applied;
  switch (decision?.kind) {
    case "unproven":
      return state.documents.length > 0;
    case "billing":
      return routed;
    case "route":
      return routed && (!decision.needsCritic || state.critic !== null);
    default:
      return false;
  }
}

function resultStatus(
  state: ReplayState,
  terminal: boolean
): TriageResult["status"] {
  if (state.rootTurn === "cancelled") {
    return "cancelled";
  }
  return state.rootTurn === "completed" && terminal ? "completed" : "failed";
}

export const replaySettled = (state: ReplayState) => state.rootTurn !== null;

export function buildReplayResult(
  state: ReplayState,
  runId: string
): TriageResult {
  const decision = finalDecision(state);
  const applied = appliedRoute(state);
  const route = decision?.kind === "route" ? decision : null;
  const document = state.documents.at(-1);
  return {
    caseId: state.case.id,
    critic: state.critic,
    document: document
      ? { text: document.content, updatedAt: document.updatedAt }
      : null,
    evidenceMisses: state.evidenceMisses,
    final: decision && {
      assignee: applied.assignee,
      classification: route?.classification ?? null,
      duplicateOf: applied.duplicateOf,
      master: applied.master,
      outcome: decision.kind === "unproven" ? "unproven" : "route",
      path: decision.kind === "billing" ? BILLING_PATH : (route?.path ?? null),
      project: applied.project,
    },
    foremanCommit: state.stamp.foremanCommit,
    run: Number(state.caseKey.split("#")[1] ?? 1),
    runId,
    startedAt: state.stamp.startedAt,
    status: resultStatus(state, reachedTerminal(state, decision)),
  };
}
