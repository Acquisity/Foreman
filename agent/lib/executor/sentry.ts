import { z } from "zod";
import { invokeProvider, type ProviderContext } from "../support/provider.js";
import { operationPath } from "./bindings.js";
import { ExecutorError } from "./transport.js";

export const sentryIssueInput = z.strictObject({
  issueId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/u),
  limit: z.number().int().min(1).max(100).optional(),
  operation: z.enum(["get_issue_details", "search_issue_events"]),
  organizationSlug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/u),
  period: z.enum(["24h", "7d", "14d", "30d", "90d"]).optional(),
  query: z.string().max(2000).optional(),
});

/** Only these two catalog reads can cross the Sentry dispatcher boundary. */
export async function readSentryIssue(input: unknown, ctx: ProviderContext) {
  const parsed = sentryIssueInput.parse(input);
  const args =
    parsed.operation === "get_issue_details"
      ? { issueId: parsed.issueId, organizationSlug: parsed.organizationSlug }
      : {
          issueId: parsed.issueId,
          limit: parsed.limit ?? 20,
          organizationSlug: parsed.organizationSlug,
          period: parsed.period ?? "24h",
          query: parsed.query ?? "",
        };
  const path = operationPath("sentry.issueRead");
  const inputArgs = { arguments: args, name: parsed.operation };
  const outcome = await invokeProvider(ctx, path, inputArgs);
  if (!outcome.ok) {
    throw new ExecutorError("sentry_read_failed", outcome.error.status, {
      retryAfter: outcome.error.retryAfter,
    });
  }
  const result = z
    .object({
      content: z.array(
        z.object({ text: z.string().optional(), type: z.string() })
      ),
      isError: z.boolean().optional(),
    })
    .parse(outcome.data);
  if (result.isError) {
    throw new ExecutorError("sentry_read_failed");
  }
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return { text: text.slice(0, 100_000), truncated: text.length > 100_000 };
}
