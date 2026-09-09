import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { describeExecutorOperation } from "../lib/executor/transport.js";
import { claimFromContext } from "../lib/support/auth.js";
import { SUPPORT_PATHS } from "../lib/support/catalog.js";
import { SUPPORT_TEAM } from "../lib/support/config.js";
import {
  assertSupportOperation,
  invokeProvider,
  matchSupportIssue,
  providerContext,
  supportIssueInput,
} from "../lib/support/provider.js";

const WORDS = /\s+/;
const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("match-issue"),
    creationRole: z.enum(["customer-report", "billing", "engineering-master"]),
    issueId: z.string().min(1).max(100),
  }),
  z.object({ action: z.literal("search"), query: z.string().max(200) }),
  z.object({ action: z.literal("describe"), path: z.string().max(200) }),
  z.object({
    action: z.literal("call"),
    creationRole: z
      .enum(["customer-report", "billing", "engineering-master"])
      .optional(),
    input: z.record(z.string(), z.unknown()),
    path: z.string().max(200),
  }),
]);

const tool = defineTool({
  approval: (ctx) =>
    claimFromContext(ctx)
      ? "not-applicable"
      : { reason: "Scheduled support only.", type: "denied" },
  description:
    "Discover and call the support toolkit's existing provider operations. Search paths, describe the exact input schema, then call one operation with its input. All required evidence reads and pagination remain available. Linear issue creation requires a stable creationRole (customer-report, billing, engineering-master); retries reuse that role's persisted result. Delegate reads only; the root owns Linear writes. No arbitrary code or broader toolkit fallback.",
  async execute(input, ctx) {
    const claim = claimFromContext(ctx);
    if (!claim) {
      throw new Error("Scheduled support identity required.");
    }
    const connection = await providerContext(ctx);
    if (input.action === "match-issue") {
      return matchSupportIssue(ctx, input.issueId, input.creationRole);
    }
    if (input.action === "search") {
      const terms = input.query.toLowerCase().split(WORDS).filter(Boolean);
      return {
        paths: SUPPORT_PATHS.filter((path) =>
          terms.every((term) => path.toLowerCase().includes(term))
        ),
      };
    }
    if (!SUPPORT_PATHS.some((path) => path === input.path)) {
      throw new Error("Operation is not in the support catalog.");
    }
    if (input.action === "describe") {
      return describeExecutorOperation(connection, input.path);
    }
    if (JSON.stringify(input.input).length > 100_000) {
      throw new Error("Provider input exceeds its bound.");
    }
    assertSupportOperation(input.path, input.input);
    if (input.path.startsWith("foreman_linear_write_api.")) {
      throw new Error(
        "Use the authored Linear routing and document helpers for fixed GraphQL writes."
      );
    }
    const creatingIssue = input.path.endsWith(".save_issue") && !input.input.id;
    if (
      creatingIssue &&
      (!input.creationRole ||
        input.input.team !== SUPPORT_TEAM ||
        typeof input.input.title !== "string" ||
        !input.input.title.trim())
    ) {
      throw new Error(
        "Issue creation needs a title, its stable creationRole and the Engineering team id."
      );
    }
    if (
      input.path.endsWith(".save_document") &&
      !input.input.id &&
      !input.input.issue
    ) {
      throw new Error(
        "Support documents must belong to an investigated issue."
      );
    }
    return invokeProvider(
      ctx,
      input.path,
      creatingIssue
        ? supportIssueInput(claim, input.creationRole ?? "", input.input)
        : input.input,
      creatingIssue ? `create-issue:${input.creationRole}` : undefined
    );
  },
  inputSchema,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => (claimFromContext(ctx) ? tool : null),
  },
});
