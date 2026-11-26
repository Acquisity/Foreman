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
 * What the investigator could call in this case: the hand-written tools, the
 * endpoint tools the case's own endpoint list offered (none when the case
 * recorded no list), and any other widget tool the run itself called, so a
 * reply recorded before a tool was retired is judged against the tools it had.
 */
export const judgeToolCapabilities = (
  endpoints: readonly AvailableEndpoint[] | undefined,
  calledTools: readonly string[] = []
) => {
  const offered = [
    ...handWrittenCapabilities,
    ...offeredEndpointTools(endpoints).map(
      ({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      })
    ),
  ];
  const known = new Set(offered.map(({ name }) => name));
  const retired = [...new Set(calledTools)]
    .filter((name) => name.startsWith("widget_") && !known.has(name))
    .map((name) => ({ description: RETIRED_TOOL, inputSchema: {}, name }));
  return [...offered, ...retired];
};
