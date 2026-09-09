import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExecutorOutcome, ProviderContext } from "../executor/dispatch.js";
import { SUPPORT_TOOLKIT } from "../executor/endpoint.js";
import { LINEAR_OPERATIONS } from "../linear-operations.js";
import { claimFromContext } from "./auth.js";
import { SUPPORT_PATHS } from "./catalog.js";
import { SupportRefusal } from "./errors.js";
import { writtenIssueId } from "./linear-state.js";
import {
  completeSupportOperation,
  requireSupportLease,
  reserveSupportOperation,
  trackSupportIssue,
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
  assertSupportPath(path);
  if (
    path.endsWith(".execute_sentry_tool") &&
    !SENTRY_READS.has(String(input.name))
  ) {
    throw new SupportRefusal(
      "This nested Sentry operation has not been audited for support reads. Use the existing search, issue, trace, event, replay or release reads."
    );
  }
}

export function assertSupportPath(path: string) {
  if (!paths.has(path)) {
    throw new SupportRefusal("This operation is outside the support toolkit.");
  }
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
      throw new SupportRefusal("A support comment requires its issue id.");
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

/** Support supplies semantics and persistence; Executor owns dispatch and journal ordering. */
export function supportOperationPolicy(ctx: ProviderContext) {
  const claim = claimFromContext(ctx);
  if (!claim) {
    return null;
  }
  return {
    assert(path: string, input: Record<string, unknown>) {
      assertSupportOperation(path, input);
      if (supportMutation(path) && ctx.session?.parent) {
        throw new SupportRefusal(
          "Delegated support investigation is read-only. Return proposed Linear changes to the root."
        );
      }
    },
    async authorize() {
      return (await requireSupportLease(claim)).version ?? "initial";
    },
    complete: (
      key: string,
      result: ExecutorOutcome,
      state: "done" | "failed"
    ) => completeSupportOperation(claim, key, result, state),
    describe: assertSupportPath,
    async record(path: string, result: ExecutorOutcome) {
      if (result.ok && path.endsWith(".save_issue")) {
        await trackSupportIssue(claim, writtenIssueId(result.data));
      }
    },
    reserve: (key: string) => reserveSupportOperation(claim, key),
    toolkit: SUPPORT_TOOLKIT as typeof SUPPORT_TOOLKIT,
    writeKey(
      path: string,
      input: Record<string, unknown>,
      version: string,
      operationKey?: string
    ) {
      if (!supportMutation(path)) {
        return null;
      }
      return operationKey ?? supportWriteKey(path, input, version);
    },
  };
}
