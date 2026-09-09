import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { executorAuth } from "../executor/auth.js";
import {
  type ExecutorRequestContext,
  invokeExecutor,
} from "../executor/transport.js";
import { LINEAR_OPERATIONS } from "../linear-operations.js";
import { claimFromContext, type SupportClaim } from "./auth.js";
import { SUPPORT_PATHS } from "./catalog.js";
import { SUPPORT_TOOLKIT } from "./config.js";
import { notificationConversation, providerData } from "./conversation.js";
import {
  completeSupportOperation,
  recordMatchedSupportIssue,
  requireSupportLease,
  reserveSupportOperation,
} from "./store.js";

const paths: ReadonlySet<string> = new Set(SUPPORT_PATHS);
const mutationNames = new Set(["save_issue", "save_document", "save_comment"]);
/** Read semantics inspected in the live Sentry catalog on 2026-09-09. */
const SENTRY_READS = new Set([
  "find_releases",
  "get_release_details",
  "get_event_attachment",
  "get_issue_tag_values",
  "get_issue_details",
  "search_issue_events",
  "get_issue_breadcrumbs",
  "get_doc",
  "get_event_stacktrace",
  "get_profile_details",
  "get_span_details",
  "search_docs",
  "get_trace_details",
  "get_agent_conversation_details",
  "get_ai_conversation_details",
  "get_replay_details",
  "get_dashboard_details",
  "get_monitor_details",
  "search_events",
  "search_issues",
]);
export const supportMutation = (path: string) =>
  mutationNames.has(path.split(".").at(-1) ?? "") ||
  path.startsWith("foreman_linear_write_api.");

export function assertSupportOperation(
  path: string,
  input: Record<string, unknown>
) {
  if (!paths.has(path)) {
    throw new Error("This operation is outside the support toolkit.");
  }
  if (
    path.endsWith(".execute_sentry_tool") &&
    !SENTRY_READS.has(String(input.name))
  ) {
    throw new Error(
      "This nested Sentry operation has not been audited for support reads. Use the existing search, issue, trace, event, replay or release reads."
    );
  }
}

export async function matchSupportIssue(
  ctx: ProviderContext,
  issueId: string,
  role: string
) {
  const claim = ctx.session ? claimFromContext({ session: ctx.session }) : null;
  if (!claim || ctx.session?.parent) {
    throw new Error("Only the support root can match its Linear record.");
  }
  const result = await invokeProvider(
    ctx,
    "linear.org.workspaceLinear.get_issue",
    { id: issueId }
  );
  if (!result.ok) {
    throw new Error("Could not verify the existing Linear record.");
  }
  const issue = z
    .object({ description: z.string() })
    .passthrough()
    .parse(providerData(result.data));
  const matches =
    role === "engineering-master"
      ? issue.description.includes(supportIssueMarker(claim, role))
      : notificationConversation(
          { app_id: "A0", text: issue.description, ts: claim.thread },
          "A0"
        ) === claim.conversation;
  if (!matches) {
    throw new Error(
      "The existing issue does not identify this Intercom source unambiguously."
    );
  }
  return recordMatchedSupportIssue(claim, `create-issue:${role}`, result);
}

function supportIssueMarker(claim: SupportClaim, role: string) {
  return `Foreman support operation: ${createHash("sha256").update(`${claim.conversation}/${claim.thread}/${role}`).digest("hex")}`;
}

export function supportIssueInput(
  claim: SupportClaim,
  role: string,
  input: Record<string, unknown>
) {
  const source =
    role === "engineering-master"
      ? ""
      : `\nIntercom source: https://app.intercom.com/a/inbox/ls8uffkp/inbox/shared/all/conversation/${claim.conversation}`;
  return {
    ...input,
    description: `${String(input.description ?? "")}\n\n${supportIssueMarker(claim, role)}${source}`,
  };
}

export type ProviderContext = Pick<ToolContext, "abortSignal" | "getToken"> &
  Partial<Pick<ToolContext, "session">>;

export async function providerContext(
  ctx: ProviderContext
): Promise<ExecutorRequestContext> {
  const claim = ctx.session ? claimFromContext({ session: ctx.session }) : null;
  if (claim) {
    await requireSupportLease(claim);
  }
  const { token } = await ctx.getToken(executorAuth());
  return {
    signal: ctx.abortSignal,
    token,
    ...(claim ? { toolkit: SUPPORT_TOOLKIT } : {}),
  };
}

/** Every authored helper shares this dispatch boundary, including delegated helpers. */
export async function invokeProvider(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>,
  operationKey?: string
) {
  const claim = ctx.session ? claimFromContext({ session: ctx.session }) : null;
  if (claim) {
    assertSupportOperation(path, input);
    if (supportMutation(path) && ctx.session?.parent) {
      throw new Error(
        "Delegated support investigation is read-only. Return the proposed Linear change to the root."
      );
    }
  }
  const connection = await providerContext(ctx);
  if (!(claim && supportMutation(path))) {
    return invokeExecutor(connection, path, input);
  }
  return journalSupportWrite(
    claim,
    operationKey ??
      supportWriteKey(
        path,
        input,
        (await requireSupportLease(claim)).version ?? "initial"
      ),
    () => invokeExecutor(connection, path, input)
  );
}

export function supportWriteKey(
  path: string,
  input: Record<string, unknown>,
  version: string
) {
  let identity: unknown = input;
  if (path.endsWith(".save_document") && !input.id) {
    identity = { issue: input.issue, title: input.title };
  } else if (path.endsWith(".save_comment") && !input.id) {
    const issue = input.issueId ?? input.issue;
    if (!issue) {
      throw new Error("A support comment requires its issue id.");
    }
    identity = { issue, version };
  } else if (path.startsWith("foreman_linear_write_api.")) {
    const body = z
      .object({
        query: z.string(),
        variables: z.record(z.string(), z.unknown()),
      })
      .parse(input.body);
    if (body.query === LINEAR_OPERATIONS.CreateDocument.document) {
      const document = z
        .object({ input: z.object({ issueId: z.string(), title: z.string() }) })
        .parse(body.variables).input;
      identity = { issue: document.issueId, title: document.title };
    }
  }
  return `${path}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

async function journalSupportWrite(
  claim: SupportClaim,
  key: string,
  write: () => ReturnType<typeof invokeExecutor>
) {
  const reserved = await reserveSupportOperation(claim, key);
  if (!reserved.fresh) {
    return reserved.result as Awaited<ReturnType<typeof invokeExecutor>>;
  }
  const result = await write();
  if (result.ok) {
    const data = result.data as {
      isError?: boolean;
      errors?: unknown[];
    } | null;
    if (data?.isError || data?.errors?.length) {
      throw new Error(
        "Linear returned an application error. Reconcile the reserved write before retrying."
      );
    }
    await completeSupportOperation(claim, key, result);
  } else if (
    [400, 401, 403, 404, 422, 429].includes(result.error.status ?? 0)
  ) {
    await completeSupportOperation(claim, key, result, "failed");
  }
  return result;
}
