import {
  type LanguageModelMiddleware,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from "ai";
import { ticketLinkedModel } from "./ticket-link-model.js";
import {
  nextActionEnabled,
  note,
  widgetNextActionMiddleware,
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
  "widget_sdr_thread_status",
  "widget_website_status",
]);
/** Past this many tool calls the model is told to stop gathering and answer. */
const MAX_WIDGET_TOOL_CALLS = 14;
const ARTICLE_TOOLS = new Set([
  "widget_help_article",
  "widget_read_help_article",
]);
const MAX_WORKSPACE_CALLS = MAX_WIDGET_TOOL_CALLS - 2;
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
 * tool calls the next request advertises no tools so the model must produce its
 * findings instead of investigating forever.
 *
 * The budget is counted from the prompt, not held in memory: Eve resolves a new
 * wrapped model at every step, so an in-memory counter reset each step and never
 * stopped anything (one investigation made 37 calls to a single tool).
 */
type Prompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
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

export function widgetInvestigationMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams({ params }) {
      const used = toolCallsThisTurn(params.prompt);
      const spent = used >= MAX_WIDGET_TOOL_CALLS;
      const { toolChoice: requestedToolChoice } = params;
      const tools = spent
        ? []
        : params.tools?.filter(
            (tool) =>
              typeof tool.name === "string" &&
              ALLOWED_TOOLS.has(tool.name) &&
              (used < MAX_WORKSPACE_CALLS || ARTICLE_TOOLS.has(tool.name))
          );
      const toolChoice =
        spent ||
        (requestedToolChoice?.type === "tool" &&
          !tools?.some((tool) => tool.name === requestedToolChoice.toolName))
          ? undefined
          : requestedToolChoice;
      return Promise.resolve({
        ...params,
        prompt:
          used < MAX_WORKSPACE_CALLS
            ? params.prompt
            : [
                ...params.prompt,
                note(
                  spent
                    ? "The investigation tool budget is exhausted. State the verified findings and limitations. Do not give product steps unless an applicable article was actually read. If no article supports a step, acknowledge that documentation could not be confirmed."
                    : "Stop workspace reads. The remaining calls are reserved for searching and reading applicable Help Center instructions. Product steps require an article actually read; otherwise report findings and the documentation gap."
                ),
              ],
        toolChoice,
        tools,
      });
    },
    // One step can ask for several calls at once: at 12 spent, a batch of four
    // made 16. Calls past the budget are dropped before the SDK dispatches them.
    async wrapGenerate({ doGenerate, params }) {
      const generated = await doGenerate();
      let left = MAX_WIDGET_TOOL_CALLS - toolCallsThisTurn(params.prompt);
      const result = {
        ...generated,
        content: generated.content.filter((part) => {
          if (part.type !== "tool-call" || !namedTool(part)) {
            return true;
          }
          if (left <= 2 && !ARTICLE_TOOLS.has(part.toolName)) {
            return false;
          }
          left -= 1;
          return left >= 0;
        }),
      };
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
      return result;
    },
    async wrapStream({ doStream, params }) {
      const result = await doStream();
      const allowedCalls = new Set<string>();
      let left = MAX_WIDGET_TOOL_CALLS - toolCallsThisTurn(params.prompt);
      const admittedCalls = new Map<string, boolean>();
      const admit = (id: string, toolName: string) => {
        if (admittedCalls.has(id)) {
          return;
        }
        const keep = left > 0 && (left > 2 || ARTICLE_TOOLS.has(toolName));
        admittedCalls.set(id, keep);
        if (keep) {
          left -= 1;
        }
      };
      const callId = (part: object) => {
        const { id, toolCallId } = part as { id?: string; toolCallId?: string };
        return toolCallId ?? id;
      };
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform: (part, controller) => {
              assertAllowedStreamPart(part, allowedCalls);
              if (
                part.type === "tool-input-start" ||
                part.type === "tool-call"
              ) {
                admit(String(callId(part)), part.toolName);
              }
              if (
                part.type === "finish" &&
                part.finishReason.unified === "tool-calls" &&
                ![...admittedCalls.values()].includes(true)
              ) {
                throw new Error(BLOCKED);
              }
              const id = part.type.startsWith("tool-")
                ? callId(part)
                : undefined;
              if (id !== undefined && admittedCalls.get(String(id)) === false) {
                return;
              }
              controller.enqueue(part);
            },
          })
        ),
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
export const widgetInvestigationModel = (id: string, sessionId?: string) =>
  wrapLanguageModel({
    middleware: nextActionEnabled()
      ? [
          widgetInvestigationMiddleware(),
          simulateStreamingMiddleware(),
          widgetNextActionMiddleware({ sessionId }),
        ]
      : widgetInvestigationMiddleware(),
    model: ticketLinkedModel(id),
  });
