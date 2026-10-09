import { z } from "zod";
import { tool as account_access } from "../tools/widget_account_access.js";
import { tool as ask_customer } from "../tools/widget_ask_customer.js";
import { tool as billing_summary } from "../tools/widget_billing_summary.js";
import { tool as crm_contact } from "../tools/widget_crm_contact.js";
import { tool as file_ticket } from "../tools/widget_file_ticket.js";
import { tool as generation_diagnostics } from "../tools/widget_generation_diagnostics.js";
import { tool as help_article } from "../tools/widget_help_article.js";
import { tool as inbox_health } from "../tools/widget_inbox_health.js";
import { tool as job_failures } from "../tools/widget_job_failures.js";
import { tool as known_issues } from "../tools/widget_known_issues.js";
import { tool as lead_pipeline_status } from "../tools/widget_lead_pipeline_status.js";
import { tool as outreach_health } from "../tools/widget_outreach_health.js";
import { tool as provisioning_status } from "../tools/widget_provisioning_status.js";
import { tool as read_help_article } from "../tools/widget_read_help_article.js";
import { tool as read_recording } from "../tools/widget_read_recording.js";
import { tool as sdr_thread_status } from "../tools/widget_sdr_thread_status.js";
import { tool as website_status } from "../tools/widget_website_status.js";

/** The investigator's actual definitions, including selector and recording-only tools. No callbacks run. */
export const judgeToolCapabilities = Object.entries({
  widget_account_access: account_access,
  widget_ask_customer: ask_customer,
  widget_billing_summary: billing_summary,
  widget_crm_contact: crm_contact,
  widget_file_ticket: file_ticket,
  widget_generation_diagnostics: generation_diagnostics,
  widget_help_article: help_article,
  widget_inbox_health: inbox_health,
  widget_job_failures: job_failures,
  widget_known_issues: known_issues,
  widget_lead_pipeline_status: lead_pipeline_status,
  widget_outreach_health: outreach_health,
  widget_provisioning_status: provisioning_status,
  widget_read_help_article: read_help_article,
  widget_read_recording: read_recording,
  widget_sdr_thread_status: sdr_thread_status,
  widget_website_status: website_status,
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
