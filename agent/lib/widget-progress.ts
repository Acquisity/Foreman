import { z } from "zod";

export const widgetProgressSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.enum([
          "account",
          "billing",
          "campaigns",
          "inboxes",
          "orders",
          "website",
          "leads",
          "conversations",
          "jobs",
          "issues",
          "guides",
          "generation",
        ]),
        status: z.enum(["running", "completed", "unavailable"]),
      })
    )
    .max(12),
  sequence: z.number().int().nonnegative(),
  stage: z.enum(["investigating", "preparing"]),
});
export type WidgetProgress = z.infer<typeof widgetProgressSchema>;
type CheckId = WidgetProgress["checks"][number]["id"];
const checks: Record<string, CheckId> = {
  widget_account_access: "account",
  widget_billing_summary: "billing",
  widget_generation_diagnostics: "generation",
  widget_help_article: "guides",
  widget_inbox_health: "inboxes",
  widget_job_failures: "jobs",
  widget_known_issues: "issues",
  widget_lead_pipeline_status: "leads",
  widget_outreach_health: "campaigns",
  widget_provisioning_status: "orders",
  widget_read_help_article: "guides",
  widget_sdr_thread_status: "conversations",
  widget_website_status: "website",
};
const eventSchema = z.object({
  data: z.object({
    actions: z
      .array(z.object({ callId: z.string(), toolName: z.string().optional() }))
      .optional(),
    result: z
      .object({
        callId: z.string(),
        kind: z.string(),
        output: z.unknown().optional(),
        toolName: z.string().optional(),
      })
      .optional(),
    sequence: z.number().int().nonnegative(),
    status: z.string().optional(),
  }),
  type: z.string(),
});

type Check = WidgetProgress["checks"][number];
const priority = { completed: 0, running: 2, unavailable: 1 };
function groupedChecks(calls: Map<string, Check>): Check[] {
  const grouped = new Map<CheckId, Check["status"]>();
  for (const call of calls.values()) {
    const current = grouped.get(call.id) ?? "completed";
    grouped.set(
      call.id,
      priority[current] > priority[call.status] ? current : call.status
    );
  }
  return [...grouped].map(([id, status]) => ({ id, status }));
}
function failedResult(data: z.infer<typeof eventSchema>["data"]): boolean {
  if (data.status === "failed" || data.result?.kind === "tool-error") {
    return true;
  }
  const output = data.result?.output;
  if (typeof output !== "object" || output === null) {
    return false;
  }
  return (
    ("status" in output &&
      ["unavailable", "denied"].includes(String(output.status))) ||
    ("success" in output && output.success === false) ||
    ("error" in output && Boolean(output.error))
  );
}
function recordProgress(
  calls: Map<string, Check>,
  event: z.infer<typeof eventSchema>
): boolean {
  const { type, data } = event;
  if (type === "actions.requested") {
    for (const action of data.actions ?? []) {
      const id = checks[action.toolName ?? ""];
      if (id && !calls.has(action.callId)) {
        calls.set(action.callId, { id, status: "running" });
      }
    }
    return true;
  }
  if (type !== "action.result" || !data.result) {
    return false;
  }
  const call = calls.get(data.result.callId);
  if (!call) {
    return false;
  }
  call.status = failedResult(data) ? "unavailable" : "completed";
  return true;
}
/** Rebuilt from this turn's durable stream. Only fixed identifiers leave this reducer. */
export function progressFromEvents() {
  const calls = new Map<string, Check>();
  let sequence = 0;
  return (event: unknown): WidgetProgress | null => {
    sequence += 1;
    const parsed = eventSchema.safeParse(event);
    if (!(parsed.success && recordProgress(calls, parsed.data))) {
      return null;
    }
    return {
      checks: groupedChecks(calls),
      sequence,
      stage: "investigating",
    };
  };
}
