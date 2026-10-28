import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  fileMigrationTicket,
  migrationTicketInputSchema,
} from "#lib/migration-ticket.js";
import { filingScope } from "#lib/migration-ticket-scope.js";

export const tool = defineTool({
  approval: (ctx) =>
    filingScope(ctx.session.auth)
      ? "not-applicable"
      : {
          reason: "Only a person in a ticket-filing channel's thread can file.",
          type: "denied",
        },
  description:
    "File this Slack thread's one Engineering ticket, into Triage, for a report that needs engineering: a bug, something worth improving, or a workaround that still needs the real fix. Never for working as intended or couldn't find it. The team, state, owner, workspace and thread come from the Slack session, never from this input, and the ticket starts Foreman's triage. A thread gets one ticket: a later call returns the one it has. It refuses with missing and the field names when something required is absent, so ask the rep for exactly those. It returns candidates when an open ticket may already cover the report: read them, and if one does, reply with its link and file nothing.",
  execute: (input, ctx) => fileMigrationTicket(ctx, input),
  inputSchema: migrationTicketInputSchema,
  outputSchema: z.union([
    z.object({
      existing: z.literal(true),
      identifier: z.string(),
      url: z.string(),
    }),
    z.object({
      existing: z.literal(false),
      identifier: z.string(),
      threadSynced: z.boolean(),
      url: z.string(),
    }),
    z.object({ missing: z.array(z.string()), reason: z.string() }),
    z.object({
      candidates: z.array(
        z.object({ identifier: z.string(), title: z.string(), url: z.string() })
      ),
      reason: z.string(),
    }),
    z.object({ error: z.string() }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      filingScope(ctx.session.auth) ? tool : null,
  },
});
