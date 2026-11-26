import { z } from "zod";
import { tool as ask_customer } from "../tools/widget_ask_customer.js";
import { tool as file_ticket } from "../tools/widget_file_ticket.js";
import { tool as help_article } from "../tools/widget_help_article.js";
import { tool as known_issues } from "../tools/widget_known_issues.js";
import { tool as read_help_article } from "../tools/widget_read_help_article.js";
import { tool as read_recording } from "../tools/widget_read_recording.js";
import type { AvailableEndpoint } from "./widget-endpoint-schema.js";
import { offeredEndpointTools } from "./widget-endpoint-tools.js";

/** The investigator's actual definitions, including selector and recording-only tools. No callbacks run. */
const handWrittenCapabilities = Object.entries({
  widget_ask_customer: ask_customer,
  widget_file_ticket: file_ticket,
  widget_help_article: help_article,
  widget_known_issues: known_issues,
  widget_read_help_article: read_help_article,
  widget_read_recording: read_recording,
}).map(([name, tool]) => {
  if (!(tool.inputSchema instanceof z.ZodType)) {
    throw new Error(`Judge capability schema is not Zod: ${name}`);
  }
  return {
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }),
    name,
  };
});

const RETIRED_TOOL =
  "A tool this run had that has since been retired. It was available to the investigator; what it read is in its toolResults.";
/**
 * The area each retired single-area tool answered for (ENG-20544). A run that
 * called one predates its area's endpoint, so that endpoint tool is left out.
 */
const RETIRED_TOOL_AREAS: Readonly<Record<string, string>> = {
  widget_account_access: "account",
  widget_billing_summary: "billing",
  widget_generation_diagnostics: "ai-generation",
  widget_inbox_health: "inboxes",
  widget_lead_pipeline_status: "lead-pipeline",
  widget_outreach_health: "campaigns",
  widget_provisioning_status: "orders",
  widget_sdr_thread_status: "ai-sdr",
};

/**
 * What the investigator could call in this case: the hand-written tools, the
 * endpoint tools the case's own endpoint list offered (none when the case
 * recorded no list), and any other widget tool the run itself called. A run
 * recorded before a tool was retired is judged with that tool, by name only,
 * and without the endpoint that later replaced it.
 */
export const judgeToolCapabilities = (
  endpoints: readonly AvailableEndpoint[] | undefined,
  calledTools: readonly string[] = []
) => {
  const called = new Set(calledTools);
  const predates = new Set(
    [...called].flatMap((name) => RETIRED_TOOL_AREAS[name] ?? [])
  );
  const offered = [
    ...handWrittenCapabilities,
    ...offeredEndpointTools(endpoints)
      .filter(({ area }) => !predates.has(area))
      .map(({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      })),
  ];
  const known = new Set(offered.map(({ name }) => name));
  const retired = [...called]
    .filter((name) => name.startsWith("widget_") && !known.has(name))
    .map((name) => ({ description: RETIRED_TOOL, inputSchema: {}, name }));
  return [...offered, ...retired];
};
