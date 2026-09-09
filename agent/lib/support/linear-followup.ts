import { z } from "zod";
import { invokeProvider, type ProviderContext } from "../executor/dispatch.js";
import { requireSupportContext, type SupportClaim } from "./auth.js";
import { providerData } from "./conversation.js";
import {
  digest,
  issueSnapshot,
  type LinearSnapshot,
  linkedIssue,
  writtenIssueId,
} from "./linear-state.js";
import {
  requireSupportLease,
  supportOperations,
  trackSupportIssue,
} from "./store.js";

const PATH = "linear.org.workspaceLinear.";
async function read(
  ctx: ProviderContext,
  operation: string,
  input: Record<string, unknown>
) {
  const result = await invokeProvider(ctx, PATH + operation, input);
  if (!result.ok) {
    throw new Error("Linked Linear evidence is unavailable.");
  }
  return providerData(result.data);
}

export async function readLinkedIssue(ctx: ProviderContext, id: string) {
  return linkedIssue.parse(
    await read(ctx, "get_issue", {
      id,
      includeRelations: true,
      includeReleases: true,
    })
  );
}

export async function trackLinkedIssue(ctx: ProviderContext, id: string) {
  const claim = requireSupportContext(ctx);
  const issue = await readLinkedIssue(ctx, id);
  await trackSupportIssue(claim, issue.id);
  return { issue, tracked: true };
}

async function readComments(ctx: ProviderContext, id: string) {
  const comments: unknown[] = [];
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each cursor depends on the previous page.
    const result = await read(ctx, "list_comments", {
      issueId: id,
      limit: 100,
      orderBy: "updatedAt",
      ...(cursor ? { cursor } : {}),
    });
    const data = z
      .object({
        comments: z.array(z.unknown()),
        cursor: z.string().optional(),
        hasNextPage: z.boolean(),
        nextCursor: z.string().optional(),
      })
      .parse(result);
    comments.push(...data.comments);
    bytes += Buffer.byteLength(JSON.stringify(data.comments), "utf8");
    if (bytes > 1_000_000) {
      throw new Error("Linear comment evidence exceeded its output bound.");
    }
    if (!data.hasNextPage) {
      return comments;
    }
    const next = data.nextCursor ?? data.cursor;
    if (!next || next === cursor) {
      throw new Error("Linear comment history is incomplete.");
    }
    cursor = next;
  }
  throw new Error("Linear comment history exceeded its scan bound.");
}

export async function readLinearFollowup(
  ctx: ProviderContext,
  claim: SupportClaim
) {
  const row = await requireSupportLease(claim);
  const snapshot: LinearSnapshot = {};
  const changes: unknown[] = [];
  for (const id of [...row.linear_ids].sort()) {
    // biome-ignore lint/performance/noAwaitInLoops: bound provider concurrency for the per-case watch list.
    const issue = await readLinkedIssue(ctx, id);
    const comments = await readComments(ctx, id);
    snapshot[id] = issueSnapshot(issue, comments);
    if (snapshot[id].fingerprint !== row.linear_processed[id]?.fingerprint) {
      changes.push({
        comments,
        issue,
        previous: row.linear_processed[id] ?? null,
      });
    }
  }
  return { changes, snapshot, version: digest(snapshot) };
}

/** Recovery is an explicit open-time mutation, never part of evidence reads. */
export async function recoverSupportIssues(claim: SupportClaim) {
  const row = await requireSupportLease(claim);
  const known = new Set(row.linear_ids);
  // Recover a successful write journaled immediately before a crash in watch-list registration.
  for (const operation of await supportOperations(claim)) {
    const key = String(operation.operation_key);
    if (
      operation.state !== "done" ||
      !(key.startsWith("create-issue:") || key.startsWith(`${PATH}save_issue:`))
    ) {
      continue;
    }
    const result = z
      .object({ data: z.unknown(), ok: z.literal(true) })
      .parse(operation.result);
    const id = writtenIssueId(result.data);
    if (!known.has(id)) {
      // biome-ignore lint/performance/noAwaitInLoops: persist each recovered reference before scanning it.
      await trackSupportIssue(claim, id);
      known.add(id);
    }
  }
}
