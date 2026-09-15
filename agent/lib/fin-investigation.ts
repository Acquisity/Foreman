import { randomUUID } from "node:crypto";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { z } from "zod";
import { verifyFinContext } from "./fin-context.js";
import { finInvestigationAuth } from "./fin-investigation-auth.js";
import {
  boundedFinAnswer,
  createFinCallback,
  deliverFinCallback,
  type FinInvestigationCallbackState,
  finInvestigationFailure,
  isFinCallbackUrl,
} from "./fin-investigation-callback.js";
import {
  type FinInvestigationResult,
  type FinInvestigationSlackReceipt,
  postFinInvestigationReceipt,
  updateFinInvestigationReceipt,
} from "./fin-investigation-slack.js";

const bearer = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;
const inputSchema = z.strictObject({
  action: z.literal("start"),
  callback_url: z.string().trim().max(2048).optional().default(""),
  conversation_id: z.string().regex(/^\d{1,32}$/),
  question: z.string().trim().min(1).max(4000),
});
const pending = {
  message:
    "The investigation has started. Wait for its result before answering the customer.",
  status: "pending" as const,
};
const genericWorkspaceReferences = new Set([
  "another",
  "any",
  "current",
  "different",
  "my",
  "other",
  "our",
  "same",
  "that",
  "the",
  "this",
  "what",
  "which",
  "whose",
  "your",
]);
const namedWorkspaceReference =
  /\b([\p{L}\p{N}][\p{L}\p{N}'’&.-]{1,63})\s+workspace\b/giu;
const workspaceNameTokens = (name: string) =>
  new Set(
    name.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’&.-]*/gu) ?? []
  );
const otherWorkspaceRequest = /\b(?:another|different|other)\s+workspace\b/iu;
const workspaceRedirect =
  "I can't check that here because it's a different workspace.";
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });

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

export function foreignWorkspaceRedirect(
  question: string,
  organizationName: string
): string | null {
  if (otherWorkspaceRequest.test(question)) {
    return workspaceRedirect;
  }
  const currentTokens = workspaceNameTokens(organizationName);
  namedWorkspaceReference.lastIndex = 0;
  for (const match of question.matchAll(namedWorkspaceReference)) {
    const reference = match[1]?.toLocaleLowerCase();
    if (
      reference &&
      !genericWorkspaceReferences.has(reference) &&
      !currentTokens.has(reference)
    ) {
      return workspaceRedirect;
    }
  }
  return null;
}

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
      if (event.type === "turn.started") {
        answer = "";
      } else if (
        event.type === "message.completed" &&
        event.data.finishReason === "stop"
      ) {
        answer = boundedFinAnswer(event.data.message);
      } else if (event.type === "session.completed") {
        return answer
          ? { message: answer, status: "completed" }
          : finInvestigationFailure;
      } else if (event.type === "session.failed") {
        return finInvestigationFailure;
      }
    }
  } catch {
    return finInvestigationFailure;
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
  }: Pick<
    RouteHandlerArgs<{
      answer: string;
      callback: FinInvestigationCallbackState | null;
      slack: FinInvestigationSlackReceipt | null;
    }>,
    "from" | "waitUntil"
  >,
  responseWaitMs = 8000,
  verifyContext = verifyFinContext,
  callbackDelivery = deliverFinCallback
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
    if (input.callback_url && !isFinCallbackUrl(input.callback_url)) {
      throw new Error("Invalid callback.");
    }
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

  const requestId = randomUUID();
  const slack = await postFinInvestigationReceipt(requestId);
  const redirect = foreignWorkspaceRedirect(
    input.question,
    context.organizationName
  );
  if (redirect) {
    const outcome = { message: redirect, status: "completed" as const };
    const callback = createFinCallback(input.callback_url);
    if (callback) {
      callback.answer = redirect;
    }
    waitUntil(
      Promise.all([
        callbackDelivery(callback, requestId, "completed"),
        updateFinInvestigationReceipt(slack, outcome),
      ])
    );
    return json({
      session_id: requestId,
      ...(input.callback_url ? pending : outcome),
    });
  }
  try {
    const session = await from(requestId).send(input.question, {
      auth: finInvestigationAuth(context),
      mode: "task",
      state: {
        answer: "",
        callback: createFinCallback(input.callback_url),
        slack,
      },
    });
    const result = waitForFinInvestigation(session)
      .then((outcome) => ({ session_id: session.id, ...outcome }))
      .catch(() => ({ session_id: session.id, ...finInvestigationFailure }));
    waitUntil(result);
    if (input.callback_url) {
      return json({ session_id: session.id, ...pending });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return json(
        await Promise.race([
          result,
          new Promise<FinInvestigationResult>((resolve) => {
            timeout = setTimeout(
              () => resolve({ session_id: session.id, ...pending }),
              responseWaitMs
            );
          }),
        ])
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    await updateFinInvestigationReceipt(slack, finInvestigationFailure);
    return json(finInvestigationFailure);
  }
}
