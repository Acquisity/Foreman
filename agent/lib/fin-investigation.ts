import type { RouteHandlerArgs, Session } from "eve/channels";
import { z } from "zod";
import { verifyFinContext } from "./fin-context.js";
import { finDeliverySuppressed, inspectFinDelivery } from "./fin-delivery.js";
import { finInvestigationAuth } from "./fin-investigation-auth.js";
import {
  finInvestigationFailure,
  isFinCallbackUrl,
  reduceFinEvent,
} from "./fin-investigation-callback.js";
import {
  type FinInvestigationResult,
  type FinInvestigationSlackReceipt,
  postFinInvestigationReceipt,
  updateFinInvestigationReceipt,
} from "./fin-investigation-slack.js";
import {
  assertFinRunOwner,
  attachFinRun,
  claimFinRun,
  completeFinRun,
  type FinRun,
  readFinRun,
} from "./fin-run-store.js";
import { logOpsEvent } from "./ops-log.js";

const bearer = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    callback_url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => !value || isFinCallbackUrl(value))
      .optional()
      .default(""),
    conversation_id: z.string().regex(/^\d{1,32}$/),
    question: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    action: z.literal("result"),
    conversation_id: z.string().regex(/^\d{1,32}$/),
    run_handle: z.uuid(),
  }),
]);
const pending = {
  message:
    "The investigation has started. Wait for its result before answering the customer.",
  status: "pending" as const,
};
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });

const finRunResponse = (run: FinRun, humanReplied: boolean) =>
  json(
    humanReplied
      ? finDeliverySuppressed
      : { run_handle: run.id, ...(run.outcome ?? pending) }
  );

const readRequestBody = async (request: Request) => {
  if (!request.body) {
    return "";
  }
  const reader = request.body.pipeThrough(new TextDecoderStream()).getReader();
  let body = "";
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: bound the streamed request before parsing it.
      const { done, value } = await reader.read();
      if (done) {
        return body;
      }
      if (body.length + value.length > 8192) {
        return null;
      }
      body += value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
};

/** Task completion, rather than an intermediate tool-call block, owns the answer. */
export async function waitForFinInvestigation(
  session: Pick<Session, "getEventStream">,
  timeoutMs = 120_000
): Promise<Pick<FinInvestigationResult, "message" | "status">> {
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  const timeout = setTimeout(
    () => reader.cancel().catch(() => undefined),
    timeoutMs
  );
  let answer = "";
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve durable stream order.
      const { done, value: event } = await reader.read();
      if (done) {
        return pending;
      }
      if (
        event.type === "turn.started" ||
        event.type === "session.completed" ||
        event.type === "session.failed"
      ) {
        const reduced = reduceFinEvent(answer, { type: event.type });
        ({ answer } = reduced);
        if (reduced.outcome) {
          return reduced.outcome;
        }
      } else if (event.type === "message.completed") {
        ({ answer } = reduceFinEvent(answer, {
          finishReason: event.data.finishReason,
          message: event.data.message,
          type: "message.completed",
        }));
      }
    }
  } catch {
    return pending;
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => undefined);
  }
}

export async function receiveFinInvestigation(
  request: Request,
  {
    from,
    waitUntil,
    attachSession,
  }: Pick<
    RouteHandlerArgs<{
      answer: string;
      runId: string | null;
      slack: FinInvestigationSlackReceipt | null;
    }>,
    "from" | "waitUntil"
  > &
    Partial<Pick<RouteHandlerArgs, "attachSession">>,
  responseWaitMs = 8000,
  verifyContext = verifyFinContext,
  dependencies = {
    attach: attachFinRun,
    claim: claimFinRun,
    complete: completeFinRun,
    inspect: inspectFinDelivery,
    postReceipt: postFinInvestigationReceipt,
    read: readFinRun,
    updateReceipt: updateFinInvestigationReceipt,
  }
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
    return json({ error: "Identity required." }, 401);
  }
  let input: z.infer<typeof inputSchema>;
  try {
    const body = await readRequestBody(request);
    if (body === null) {
      return json({ error: "Request is too large." }, 413);
    }
    input = inputSchema.parse(JSON.parse(body));
  } catch {
    return json(
      {
        message:
          "Supply the native conversation, question and Intercom callback only; no investigation was started.",
        status: "failed",
      },
      400
    );
  }
  let context: Awaited<ReturnType<typeof verifyFinContext>>;
  try {
    context = await verifyContext({
      conversationId: input.conversation_id,
      signal: request.signal,
      userToken,
    });
  } catch {
    return json(
      {
        message:
          "I couldn't check this because this chat's workspace could not be verified.",
        status: "failed",
      },
      403
    );
  }

  let acceptedRun: FinRun | undefined;
  let acceptedSessionId: string | undefined;
  let slack: FinInvestigationSlackReceipt | null = null;
  let humanReplied = false;
  const recheckDelivery = async (run: FinRun) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [current, latest] = await Promise.race([
        Promise.all([
          verifyContext({
            conversationId: input.conversation_id,
            signal,
            userToken,
          }),
          dependencies.inspect(context, undefined, signal),
        ]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Late delivery verification timed out."));
          }, 5000);
        }),
      ]);
      assertFinRunOwner(run, current);
      return latest;
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    if (input.action === "result") {
      let run = await dependencies.read(input.run_handle);
      assertFinRunOwner(run, context);
      acceptedRun = run;
      ({ humanReplied } = await dependencies.inspect(context));
      run = await recoverFinRun(
        run,
        attachSession,
        responseWaitMs,
        dependencies.complete
      );
      const latest = await recheckDelivery(run);
      return finRunResponse(run, latest.humanReplied);
    }
    const delivery = await dependencies.inspect(context);
    ({ humanReplied } = delivery);
    const { fresh, run } = await dependencies.claim(
      context,
      delivery.requestKey,
      input.callback_url
    );
    assertFinRunOwner(run, context);
    acceptedRun = run;
    if (!fresh) {
      return finRunResponse(run, delivery.humanReplied);
    }
    slack = await dependencies.postReceipt(run.id);
    const session = await from(run.id).send(input.question, {
      auth: finInvestigationAuth(context),
      mode: "task",
      state: {
        answer: "",
        runId: run.id,
        slack,
      },
    });
    acceptedSessionId = session.id;
    await dependencies.attach(run.id, session.id, slack);
    const result = waitForFinInvestigation(session).then(async (outcome) => {
      if (outcome.status !== "pending") {
        const saved = await dependencies.complete(
          run.id,
          {
            message: outcome.message,
            status: outcome.status,
          },
          session.id
        );
        return { run_handle: run.id, ...(saved.outcome ?? pending) };
      }
      return { run_handle: run.id, ...outcome };
    });
    waitUntil(result);
    if (input.callback_url) {
      return json(
        delivery.humanReplied
          ? finDeliverySuppressed
          : { run_handle: run.id, ...pending }
      );
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        result,
        new Promise<{ run_handle: string; message: string; status: "pending" }>(
          (resolve) => {
            timeout = setTimeout(
              () => resolve({ run_handle: run.id, ...pending }),
              responseWaitMs
            );
          }
        ),
      ]);
      // Never reuse intake authorization after waiting for a late answer.
      const latest = await recheckDelivery(run);
      return json(latest.humanReplied ? finDeliverySuppressed : response);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    if (slack && !acceptedSessionId) {
      // A rejected send can still have been accepted. Report uncertainty, not failure.
      await dependencies.updateReceipt(slack, {
        message: `Dispatch could not be confirmed for investigation ${acceptedRun?.id}. It may still be running. Operator recovery is required; do not start a replacement investigation.`,
        status: "failed",
      });
    }
    // An ambiguous send is not permission to release the slot and start twice.
    return finRecoveryResponse(acceptedRun, acceptedSessionId, humanReplied);
  }
}

function finRecoveryResponse(
  acceptedRun: FinRun | undefined,
  acceptedSessionId: string | undefined,
  humanReplied: boolean
) {
  logOpsEvent(
    "fin.investigation.recovery.required",
    {
      message: acceptedRun
        ? `Investigation run ${acceptedRun.id} requires recovery.`
        : "Investigation lookup unavailable.",
      outcome: "error",
      sessionId: acceptedSessionId ?? acceptedRun?.session_id,
    },
    console.warn
  );
  if (humanReplied) {
    return json(finDeliverySuppressed);
  }
  if (acceptedRun) {
    // A reference carries no findings or authorization, even if access lapsed.
    return json({
      message:
        "The investigation result could not be retrieved. Retry Get Foreman Result with this reference; do not start another investigation.",
      run_handle: acceptedRun.id,
      status: "pending",
    });
  }
  return json(finInvestigationFailure);
}

async function recoverFinRun(
  run: FinRun,
  attach: RouteHandlerArgs["attachSession"] | undefined,
  timeoutMs: number,
  complete = completeFinRun
) {
  if (run.outcome || !run.session_id || !attach) {
    return run;
  }
  const outcome = await waitForFinInvestigation(
    attach(run.session_id),
    timeoutMs
  );
  return outcome.status === "pending"
    ? run
    : complete(
        run.id,
        { message: outcome.message, status: outcome.status },
        run.session_id
      );
}
