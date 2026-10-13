import {
  type LanguageModelMiddleware,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from "ai";
import { logOpsEvent } from "./ops-log.js";
import { ticketLinkedModel } from "./ticket-link-model.js";
import { cacheGuide } from "./widget-instructions.js";
import {
  LATE_TOOLS,
  MAX_WIDGET_TOOL_CALLS,
  MAX_WORKSPACE_CALLS,
  nextActionEnabled,
  note,
  widgetNextActionMiddleware,
  withinBudget,
  withoutNotes,
} from "./widget-next-action.js";

/**
 * Read-only, org-scoped evidence for the in-app support lane: only the curated
 * widget_* tools, each returning a structured, bounded, org-locked object.
 * The raw exploratory tools (planetscale_execute_read_query, widget_provider,
 * describe_table) are deliberately excluded so the model cannot write its own
 * SQL or wander. No web, browser, sandbox, repo, memory, or delegation. The one
 * write is widget_file_ticket, whose target and scope come from the session.
 */
const ALLOWED_TOOLS = new Set([
  "widget_account_access",
  // Registered only while the next-action pilot is on, and offered only by its selector.
  "widget_ask_customer",
  "widget_billing_summary",
  "widget_crm_contact",
  "widget_file_ticket",
  "widget_generation_diagnostics",
  "widget_help_article",
  "widget_inbox_health",
  "widget_job_failures",
  "widget_known_issues",
  "widget_lead_pipeline_status",
  "widget_outreach_health",
  "widget_provisioning_status",
  "widget_read_help_article",
  // Registered only on a turn that follows up on a screen recording.
  "widget_read_recording",
  "widget_sdr_thread_status",
  "widget_website_status",
]);
const BLOCKED = "Support investigation capability is unavailable.";

const namedTool = (part: { toolName?: unknown }) =>
  typeof part.toolName === "string" && ALLOWED_TOOLS.has(part.toolName);

function assertAllowedStreamPart(
  part: { id?: string; toolCallId?: string; toolName?: unknown; type: string },
  allowedCalls: Set<string>
) {
  if (part.type === "tool-input-start" || part.type === "tool-call") {
    if (!namedTool(part)) {
      throw new Error(BLOCKED);
    }
    allowedCalls.add(
      part.type === "tool-call" ? String(part.toolCallId) : String(part.id)
    );
    return;
  }
  if (part.type === "tool-input-delta" || part.type === "tool-input-end") {
    if (!allowedCalls.has(String(part.id))) {
      throw new Error(BLOCKED);
    }
    return;
  }
  if (
    (part.type === "tool-result" || part.type === "tool-approval-request") &&
    !allowedCalls.has(String(part.toolCallId))
  ) {
    throw new Error(BLOCKED);
  }
}

/**
 * Keep the in-app support lane to authored read-only evidence, and stop it
 * wandering: it has no web fetch or browser here, and after a fixed budget of
 * tool calls every further call is refused so the model must produce its
 * findings instead of investigating forever.
 *
 * The tools array is the same at every step of a session, with no cache marker
 * of its own: Anthropic caches tools, then system, then messages, so a tools
 * array that changed between steps re-wrote the whole guide prefix every step.
 * The budget is enforced by refusing calls, never by removing a tool, and not
 * by toolChoice none either: the Anthropic provider drops the tools for it.
 *
 * The budget is counted from the prompt, not held in memory: Eve resolves a new
 * wrapped model at every step, so an in-memory counter reset each step and never
 * stopped anything (one investigation made 37 calls to a single tool).
 */
type Prompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
type StreamPart =
  Awaited<
    ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
  >["stream"] extends ReadableStream<infer P>
    ? P
    : never;
const toolCallsThisTurn = (withControl: Prompt) => {
  const prompt = withoutNotes(withControl);
  return prompt
    .slice(prompt.map((message) => message.role).lastIndexOf("user") + 1)
    .reduce(
      (total, message) =>
        message.role === "assistant"
          ? total +
            message.content.filter((part) => part.type === "tool-call").length
          : total,
      0
    );
};

/**
 * One line per model call. The start is an absolute time because Vercel groups
 * a request's lines under one timestamp: the gap from one call's end to the
 * next call's start bounds the time between calls, including tool reads.
 */
const logModelCall = (
  sessionId: string | undefined,
  startedAt: number,
  tools: string[]
) =>
  logOpsEvent("widget.investigation.model_call", {
    message: `start=${startedAt} ms=${Date.now() - startedAt}`,
    sessionId,
    tool: tools.join(",") || null,
  });

const callId = (part: object) => {
  const { id, toolCallId } = part as { id?: string; toolCallId?: string };
  return toolCallId ?? id;
};

/**
 * Admits a step's tool calls while the budget lasts (the last two are for
 * articles and the ticket) and drops the rest before the SDK runs them. A call
 * to a tool outside the lane fails the step. When the budget refused every call,
 * `retry` marks the step to be asked again instead of failing it.
 */
function guardStream(
  stream: ReadableStream<StreamPart>,
  opts: {
    admitted: string[];
    left: number;
    onFinish: () => void;
    retry: boolean;
  }
) {
  const allowedCalls = new Set<string>();
  const admittedCalls = new Map<string, boolean>();
  const state: { refusedAll: boolean } = { refusedAll: false };
  let { left } = opts;
  const admit = (id: string, toolName: string) => {
    if (admittedCalls.has(id)) {
      return;
    }
    const keep = left > 0 && (left > 2 || LATE_TOOLS.has(toolName));
    admittedCalls.set(id, keep);
    if (keep) {
      left -= 1;
      opts.admitted.push(toolName);
    }
  };
  const finish = (part: StreamPart) => {
    if (part.type !== "finish") {
      return;
    }
    if (
      part.finishReason.unified === "tool-calls" &&
      ![...admittedCalls.values()].includes(true)
    ) {
      if (admittedCalls.size === 0 || !opts.retry) {
        throw new Error(BLOCKED);
      }
      state.refusedAll = true;
    }
    opts.onFinish();
  };
  return {
    state,
    stream: stream.pipeThrough(
      new TransformStream<StreamPart, StreamPart>({
        transform: (part, controller) => {
          assertAllowedStreamPart(part, allowedCalls);
          if (part.type === "tool-input-start" || part.type === "tool-call") {
            admit(String(callId(part)), part.toolName);
          }
          finish(part);
          const id = part.type.startsWith("tool-") ? callId(part) : undefined;
          if (id === undefined || admittedCalls.get(String(id)) !== false) {
            controller.enqueue(part);
          }
        },
      })
    ),
  };
}

/** Reads a stream to its end, keeping a failure to replay after the parts. */
async function hold(stream: ReadableStream<StreamPart>) {
  const parts: StreamPart[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: a stream is read in order.
      const { done, value } = await reader.read();
      if (done) {
        return { parts };
      }
      parts.push(value);
    }
  } catch (error) {
    return { failure: { error }, parts };
  }
}

const replay = (parts: StreamPart[], failure?: { error: unknown }) =>
  new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      if (failure) {
        controller.error(failure.error);
      } else {
        controller.close();
      }
    },
  });

export function widgetInvestigationMiddleware(
  sessionId?: string
): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams({ params }) {
      const used = toolCallsThisTurn(params.prompt);
      const spent = used >= MAX_WIDGET_TOOL_CALLS;
      const { toolChoice: requestedToolChoice } = params;
      // eve marks its last tool for caching. The guide's breakpoint
      // already covers the tools, and that marker would be a fifth breakpoint.
      const tools = params.tools?.flatMap((tool) =>
        typeof tool.name === "string" &&
        ALLOWED_TOOLS.has(tool.name) &&
        tool.type === "function"
          ? [{ ...tool, providerOptions: undefined }]
          : []
      );
      const toolChoice =
        requestedToolChoice?.type === "tool" &&
        !(
          withinBudget(requestedToolChoice.toolName, used) &&
          tools?.some((tool) => tool.name === requestedToolChoice.toolName)
        )
          ? undefined
          : requestedToolChoice;
      return Promise.resolve({
        ...params,
        prompt: cacheGuide(
          used < MAX_WORKSPACE_CALLS
            ? params.prompt
            : [
                ...params.prompt,
                note(
                  spent
                    ? "The investigation tool budget is exhausted. State the verified findings and limitations. Do not give product steps unless an applicable article was actually read. If no article supports a step, acknowledge that documentation could not be confirmed."
                    : "Stop workspace reads. The remaining calls are reserved for searching and reading applicable Help Center instructions, or filing a ticket the instructions require. Product steps require an article actually read; otherwise report findings and the documentation gap."
                ),
              ]
        ),
        toolChoice,
        tools,
      });
    },
    // One step can ask for several calls at once: at 12 spent, a batch of four
    // made 16. Calls past the budget are dropped before the SDK dispatches them.
    async wrapGenerate({ doGenerate, model, params }) {
      const startedAt = Date.now();
      let keptTools: string[] = [];
      try {
        const used = toolCallsThisTurn(params.prompt);
        const admit = (output: Awaited<ReturnType<typeof doGenerate>>) => {
          let left = MAX_WIDGET_TOOL_CALLS - used;
          return {
            ...output,
            content: output.content.filter((part) => {
              if (part.type !== "tool-call" || !namedTool(part)) {
                return true;
              }
              if (left <= 2 && !LATE_TOOLS.has(part.toolName)) {
                return false;
              }
              left -= 1;
              return left >= 0;
            }),
          };
        };
        const generated = await doGenerate();
        let result = admit(generated);
        const calls = (content: typeof generated.content) =>
          content.filter((part) => part.type === "tool-call");
        if (
          calls(result.content).length === 0 &&
          calls(generated.content).length > 0 &&
          calls(generated.content).every(namedTool)
        ) {
          // Only the budget refused these calls: the step is asked again, once.
          logOpsEvent("widget.investigation.refused_redo", { sessionId });
          result = admit(
            await model.doGenerate({ ...params, toolChoice: { type: "none" } })
          );
        }
        let sawAllowedCall = false;
        for (const part of result.content) {
          if (part.type === "tool-call") {
            if (!namedTool(part)) {
              throw new Error(BLOCKED);
            }
            sawAllowedCall = true;
          } else if (part.type.startsWith("tool-")) {
            throw new Error(BLOCKED);
          }
        }
        if (result.finishReason.unified === "tool-calls" && !sawAllowedCall) {
          throw new Error(BLOCKED);
        }
        keptTools = result.content.flatMap((part) =>
          part.type === "tool-call" ? [part.toolName] : []
        );
        return result;
      } finally {
        logModelCall(sessionId, startedAt, keptTools);
      }
    },
    async wrapStream({ doStream, model, params }) {
      const startedAt = Date.now();
      // Log setup failures too, before a readable stream exists.
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        logModelCall(sessionId, startedAt, []);
        throw error;
      }
      const used = toolCallsThisTurn(params.prompt);
      const admittedTools: string[] = [];
      let logged = false;
      const complete = () => {
        if (!logged) {
          logged = true;
          logModelCall(sessionId, startedAt, admittedTools);
        }
      };
      const guard = (stream: ReadableStream<StreamPart>, retry: boolean) =>
        guardStream(stream, {
          admitted: admittedTools,
          left: MAX_WIDGET_TOOL_CALLS - used,
          onFinish: complete,
          retry,
        });
      // Only in the last two calls can the budget refuse a step's every call. That
      // step is held, and if nothing was left it is asked once more with no tool.
      const held = MAX_WIDGET_TOOL_CALLS - used <= 2;
      const first = guard(result.stream, held);
      let guarded = first.stream;
      if (held) {
        const { failure, parts } = await hold(guarded);
        if (first.state.refusedAll && !failure) {
          logOpsEvent("widget.investigation.refused_redo", { sessionId });
          result = await model.doStream({
            ...params,
            toolChoice: { type: "none" },
          });
          guarded = guard(result.stream, false).stream;
        } else {
          guarded = replay(parts, failure);
        }
      }
      const reader = guarded.getReader();
      return {
        ...result,
        stream: new ReadableStream({
          async cancel(reason) {
            // Record cancellation before waiting for upstream cleanup.
            complete();
            await reader.cancel(reason);
          },
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                complete();
                controller.close();
              } else {
                controller.enqueue(value);
              }
            } catch (error) {
              complete();
              controller.error(error);
            }
          },
        }),
      };
    },
  };
}

/**
 * With the Preview next-action pilot on, the selector sits inside the guard, so
 * it only ever chooses among allowlisted tools the budget still permits. A step
 * is generated whole and replayed as a stream, because a repeated read can only
 * be caught, and the step redone, once the full call is known.
 */
export const widgetInvestigationModel = (
  id: string,
  sessionId?: string,
  stepsId?: string
) =>
  wrapLanguageModel({
    middleware: nextActionEnabled()
      ? [
          widgetInvestigationMiddleware(sessionId),
          simulateStreamingMiddleware(),
          widgetNextActionMiddleware({
            sessionId,
            stepModel: stepsId ? ticketLinkedModel(stepsId) : undefined,
          }),
        ]
      : widgetInvestigationMiddleware(sessionId),
    model: ticketLinkedModel(id),
  });
