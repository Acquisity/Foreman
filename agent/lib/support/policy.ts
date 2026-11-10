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
export const supportMutation = (path: string) =>
  mutationNames.has(path.split(".").at(-1) ?? "") ||
  path.startsWith("foreman-linear-write-api.");

// Sentry v2 lists each read as its own tool, so the path allowlist covers it.
export function assertSupportOperation(
  path: string,
  _input: Record<string, unknown>
) {
  assertSupportPath(path);
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
  } else if (path.startsWith("foreman-linear-write-api.")) {
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
