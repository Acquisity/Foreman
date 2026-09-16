import { z } from "zod";
import { readFinCaseStatus } from "./executor/dispatch.js";
import { customerCaseStatus, sameFinCaseOwner } from "./fin-case.js";
import { type FinCase, findFinCases } from "./fin-case-store.js";
import { verifyFinContext } from "./fin-context.js";
import { finDeliverySuppressed, inspectFinDelivery } from "./fin-delivery.js";
import { readRequestBody } from "./fin-investigation.js";
import { sameFinOwner } from "./fin-run-store.js";
import type { FinContext } from "./fin-scope.js";

const bearer = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;
const inputSchema = z.strictObject({
  case_reference: z
    .union([z.uuid(), z.literal("")])
    .optional()
    .transform((value) => value || undefined),
  conversation_id: z.string().regex(/^\d{1,32}$/),
  previous_status: z
    .enum([
      "triage",
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
      "",
    ])
    .optional()
    .transform((value) => value || undefined),
});
const unavailable = {
  message:
    "The current ticket status could not be checked. No investigation or ticket was started.",
  status: "unavailable",
};
const dependencies = {
  find: findFinCases,
  inspect: inspectFinDelivery,
  read: readFinCaseStatus,
  verify: verifyFinContext,
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "cache-control": "no-store" }, status });

/** A read-only entry, independent of run slots, callbacks, and run-reference expiry. */
export async function receiveFinCaseStatus(
  request: Request,
  deps = dependencies
) {
  if (
    process.env.VERCEL_ENV !== "preview" ||
    process.env.FIN_INVESTIGATION_ENABLED !== "true"
  ) {
    return json({ error: "Not found." }, 404);
  }
  const userToken = bearer.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (!userToken) {
    return json(unavailable, 401);
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(50_000)]);
  try {
    const input = inputSchema.parse(
      JSON.parse((await readRequestBody(request)) ?? "")
    );
    const context = await deps.verify({
      conversationId: input.conversation_id,
      signal,
      userToken,
    });
    if ((await deps.inspect(context, undefined, signal)).humanReplied) {
      return json(finDeliverySuppressed);
    }
    const cases = selectCases(
      await deps.find(context, input.case_reference),
      context.conversationId,
      input.case_reference
    );
    if (cases.length > 20) {
      return json({
        message:
          "Please return to the original conversation for the report you want to check.",
        status: "clarification",
      });
    }
    if (!cases.length) {
      return json(unavailable);
    }
    await verifyCaseSources(cases, context, deps, signal, userToken);
    if (cases.length > 1) {
      const current = await deps.verify({
        conversationId: input.conversation_id,
        signal,
        userToken,
      });
      if (!sameFinOwner(context, current)) {
        return json(unavailable);
      }
      if ((await deps.inspect(current, undefined, signal)).humanReplied) {
        return json(finDeliverySuppressed);
      }
      return json({
        cases: cases.map((record) => ({
          case_reference: record.id,
          reported_at: record.created_at.toISOString(),
          subject:
            record.decision.action === "file"
              ? record.decision.customerSummary
              : "Customer report",
        })),
        message: "Which of these reports would you like me to check?",
        status: "clarification",
      });
    }
    const [selected] = cases;
    const update = await deps.read(context, selected.id, signal);
    const latest = await deps.verify({
      conversationId: input.conversation_id,
      signal,
      userToken,
    });
    if (!sameFinOwner(context, latest)) {
      return json(unavailable);
    }
    if ((await deps.inspect(latest, undefined, signal)).humanReplied) {
      return json(finDeliverySuppressed);
    }
    return currentResponse(selected.id, update.state, input.previous_status);
  } catch {
    return json(unavailable);
  }
}

/** Check each original source before exposing even its customer-safe subject. */
async function verifyCaseSources(
  cases: FinCase[],
  context: FinContext,
  deps: typeof dependencies,
  signal: AbortSignal,
  userToken: string
) {
  for (const record of cases) {
    const original =
      record.scope.conversationId === context.conversationId
        ? context
        : // biome-ignore lint/performance/noAwaitInLoops: bounded source checks share the request deadline.
          await deps.verify({
            conversationId: record.scope.conversationId,
            signal,
            userToken,
          });
    if (
      !(
        sameFinOwner(original, record.scope) &&
        sameFinCaseOwner(original, context)
      )
    ) {
      throw new Error("Case source ownership changed.");
    }
  }
}

function selectCases(
  cases: FinCase[],
  conversation: string,
  reference?: string
) {
  const local = cases.filter(
    (record) => record.scope.conversationId === conversation
  );
  const selected = !reference && local.length ? local : cases;
  return [
    ...new Map(selected.map((record) => [record.issue_id, record])).values(),
  ];
}

function currentResponse(
  id: string,
  state: keyof typeof customerCaseStatus,
  previous?: string
) {
  const unchanged = previous === state;
  return json({
    case_reference: id,
    checked_at: new Date().toISOString(),
    message: `${unchanged ? "There is no change in the ticket status. " : ""}${customerCaseStatus[state]}`,
    status: unchanged ? "unchanged" : "current",
    ticket_status: state,
  });
}
