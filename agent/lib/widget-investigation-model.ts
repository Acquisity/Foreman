import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { ticketLinkedModel } from "./ticket-link-model.js";

/**
 * Read-only, org-scoped evidence for the in-app support lane: only the curated
 * widget_* tools, each returning a structured, bounded, org-locked object.
 * The raw exploratory tools (planetscale_execute_read_query, widget_provider,
 * describe_table) are deliberately excluded so the model cannot write its own
 * SQL or wander. No web, browser, sandbox, repo, memory, delegation, or writes.
 */
const ALLOWED_TOOLS = new Set([
  "widget_account_access",
  "widget_billing_summary",
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
 * ponytail: the budget counts calls seen by this middleware instance. Eve
 * resolves the wrapped model at step start, so the count is per turn, not per
 * whole task; the hard investigation deadline in widget-investigation.ts is the
 * real ceiling. Move the counter to session-keyed state if per-task bounding is
 * ever required.
 */
export function widgetInvestigationMiddleware(): LanguageModelMiddleware {
  let toolCalls = 0;
  return {
    specificationVersion: "v4",
    transformParams({ params }) {
      const spent = toolCalls >= MAX_WIDGET_TOOL_CALLS;
      const { toolChoice: requestedToolChoice } = params;
      const tools = spent
        ? []
        : params.tools?.filter(
            (tool) =>
              typeof tool.name === "string" && ALLOWED_TOOLS.has(tool.name)
          );
      const toolChoice =
        spent ||
        (requestedToolChoice?.type === "tool" &&
          !ALLOWED_TOOLS.has(requestedToolChoice.toolName))
          ? undefined
          : requestedToolChoice;
      return Promise.resolve({ ...params, toolChoice, tools });
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      let sawAllowedCall = false;
      for (const part of result.content) {
        if (part.type === "tool-call") {
          if (!namedTool(part)) {
            throw new Error(BLOCKED);
          }
          sawAllowedCall = true;
          toolCalls += 1;
        } else if (part.type.startsWith("tool-")) {
          throw new Error(BLOCKED);
        }
      }
      if (result.finishReason.unified === "tool-calls" && !sawAllowedCall) {
        throw new Error(BLOCKED);
      }
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const allowedCalls = new Set<string>();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform: (part, controller) => {
              assertAllowedStreamPart(part, allowedCalls);
              if (part.type === "tool-call") {
                toolCalls += 1;
              }
              if (
                part.type === "finish" &&
                part.finishReason.unified === "tool-calls" &&
                allowedCalls.size === 0
              ) {
                throw new Error(BLOCKED);
              }
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
}

export const widgetInvestigationModel = (id: string) =>
  wrapLanguageModel({
    middleware: widgetInvestigationMiddleware(),
    model: ticketLinkedModel(id),
  });
