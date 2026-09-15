import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { ticketLinkedModel } from "./ticket-link-model.js";

const ALLOWED_TOOLS = new Set([
  // Eve's `agent` is a root-agent copy with inherited auth and capabilities.
  // Declared specialists are separate `critic` and `vision` tool names and stay blocked.
  "agent",
  "file_fin_investigation_ticket",
  "task_cancel",
]);
const BLOCKED = "Customer investigation capability is unavailable.";
const TICKET_TOOL = "file_fin_investigation_ticket";
const TICKET_REQUEST =
  /\b(?:file|create|open|raise|log|submit)\b[\s\S]{0,120}\b(?:engineering\s+)?(?:ticket|issue)\b/iu;
const NEGATED_TICKET_REQUEST =
  /\b(?:do\s+not|don't|dont|never)\s+(?:file|create|open|raise|log|submit)\b[\s\S]{0,120}\b(?:ticket|issue)\b/iu;

interface PromptMessage {
  content: unknown;
  role: string;
}

const userText = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { text: string; type: "text" } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n");
};

const hasTicketCall = (content: unknown) =>
  Array.isArray(content) &&
  content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-call" &&
      "toolName" in part &&
      part.toolName === TICKET_TOOL
  );

const needsTicketCall = (prompt: readonly PromptMessage[]) => {
  let userIndex = -1;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) {
    return false;
  }
  const request = userText(prompt[userIndex]?.content).slice(0, 4096);
  const explicitRequest =
    !NEGATED_TICKET_REQUEST.test(request) && TICKET_REQUEST.test(request);
  return (
    explicitRequest &&
    !prompt
      .slice(userIndex + 1)
      .some((message) => hasTicketCall(message.content))
  );
};

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
 * Keep the customer lane to delegation control only until scoped evidence tools land.
 * The output checks also reject an adversarial model call that was not advertised.
 */
export const finInvestigationMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams({ params }) {
    const { prompt, toolChoice: requestedToolChoice } = params;
    const tools = params.tools?.filter(
      (tool) => typeof tool.name === "string" && ALLOWED_TOOLS.has(tool.name)
    );
    let toolChoice = requestedToolChoice;
    if (needsTicketCall(prompt)) {
      toolChoice = { toolName: TICKET_TOOL, type: "tool" };
    } else if (
      toolChoice?.type === "tool" &&
      !ALLOWED_TOOLS.has(toolChoice.toolName)
    ) {
      toolChoice = { type: "auto" };
    }
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
          transform(part, controller) {
            assertAllowedStreamPart(part, allowedCalls);
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

export const finInvestigationModel = (id: string) =>
  wrapLanguageModel({
    middleware: finInvestigationMiddleware,
    model: ticketLinkedModel(id),
  });
