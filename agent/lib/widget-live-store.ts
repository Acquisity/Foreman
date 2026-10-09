import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { WidgetDependencies } from "./widget-investigation.js";
import { assertLiveAllowed } from "./widget-live-policy.js";
import { widgetProgressSchema } from "./widget-progress.js";
import {
  assertWidgetRunOwner,
  FINISH_CLAIM_SECONDS,
  widgetOutcomeSchema,
  widgetRunSchema,
} from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";

const entrySchema = z.object({
  finishingAt: z.number().nullable(),
  requestKey: z.string(),
  run: widgetRunSchema,
});
type Entry = z.infer<typeof entrySchema>;
const ROOT = resolve(".eve/widget-live");

/** All run mutations are serialized by a bounded filesystem lock and published atomically. */
export function liveRunStore(directory = `${ROOT}/runs`) {
  assertLiveAllowed();
  const path = resolve(directory);
  if (!path.startsWith(`${ROOT}${sep}`)) {
    throw new Error("Live run storage must stay under .eve/widget-live/.");
  }
  const file = `${path}/store.json`;
  const lock = `${path}/lock`;
  async function access<T>(apply: (entries: Entry[]) => T): Promise<T> {
    await mkdir(path, { mode: 0o700, recursive: true });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each retry must acquire the same exclusive lock.
        await mkdir(lock);
        break;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        ) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "Local live store is locked; recover its lock after stopping the server.",
            { cause: error }
          );
        }
        await sleep(25);
      }
    }
    const temporary = `${file}.${randomUUID()}`;
    try {
      const text = await readFile(file, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return "[]";
          }
          throw error;
        }
      );
      const entries = z.array(entrySchema).parse(JSON.parse(text));
      const result = apply(entries);
      await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await rename(temporary, file);
      return result;
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { force: true, recursive: true });
    }
  }
  const owned = (entries: Entry[], id: string) => {
    const entry = entries.find((item) => item.run.id === id);
    if (!entry) {
      throw new Error("Local live run is unavailable.");
    }
    return entry;
  };
  const conversation = (entry: Entry, scope: WidgetContext) =>
    entry.run.scope.organizationId === scope.organizationId &&
    entry.run.scope.conversationId === scope.conversationId &&
    entry.run.scope.source === scope.source;
  const settle = (entry: Entry, outcome: unknown, findings: unknown) => {
    entry.run.outcome = widgetOutcomeSchema.parse(outcome);
    entry.run.findings = findings;
    entry.run.decision = entry.run.outcome.decision;
    entry.run.completed_at = new Date();
  };
  return {
    attach: (id, sessionId, streamIndex) =>
      access((entries) => {
        const { run } = owned(entries, id);
        if (run.session_id && run.session_id !== sessionId) {
          throw new Error("Local session ownership mismatch.");
        }
        run.session_id = sessionId;
        run.stream_index = streamIndex;
      }),
    cancel: (id) =>
      access((entries) => {
        const entry = owned(entries, id);
        if (!entry.run.outcome) {
          settle(
            entry,
            {
              decision: "block",
              message: null,
              reason: "cancelled",
              status: "failed",
            },
            null
          );
        }
      }),
    claim: (scope, requestKey, question) =>
      access((entries) => {
        const previous = entries.find(
          (candidate) =>
            conversation(candidate, scope) &&
            (candidate.requestKey === requestKey || !candidate.run.completed_at)
        );
        if (previous) {
          assertWidgetRunOwner(previous.run, scope);
          return {
            busy: previous.requestKey !== requestKey,
            fresh: false,
            run: previous.run,
          };
        }
        const entry: Entry = {
          finishingAt: null,
          requestKey,
          run: {
            completed_at: null,
            created_at: new Date(),
            decision: null,
            findings: null,
            id: randomUUID(),
            outcome: null,
            question,
            scope,
            session_id: null,
            stream_index: 0,
          },
        };
        entries.push(entry);
        return { fresh: true, run: entry.run };
      }),
    claimFinish: (id) =>
      access((entries) => {
        const entry = owned(entries, id);
        if (
          entry.run.outcome ||
          (entry.finishingAt !== null &&
            Date.now() - entry.finishingAt < FINISH_CLAIM_SECONDS * 1000)
        ) {
          return false;
        }
        entry.finishingAt = Date.now();
        return true;
      }),
    complete: (id, outcome, findings, sessionId) =>
      access((entries) => {
        const entry = owned(entries, id);
        if (entry.run.session_id && entry.run.session_id !== sessionId) {
          throw new Error("Local session ownership mismatch.");
        }
        if (!entry.run.outcome) {
          entry.run.session_id = sessionId;
          settle(entry, outcome, findings);
        }
        return entry.run;
      }),
    expire: (id, outcome, findings, olderThanMs) =>
      access((entries) => {
        const entry = owned(entries, id);
        if (
          entry.run.session_id ||
          entry.run.outcome ||
          Date.now() - entry.run.created_at.getTime() <= olderThanMs
        ) {
          return false;
        }
        settle(entry, outcome, findings);
        return true;
      }),
    expireAll: (scope, outcome, findings, olderThanMs) =>
      access((entries) => {
        const expired = entries.filter(
          (entry) =>
            conversation(entry, scope) &&
            !entry.run.session_id &&
            !entry.run.outcome &&
            Date.now() - entry.run.created_at.getTime() > olderThanMs
        );
        for (const entry of expired) {
          settle(entry, outcome, findings);
        }
        return expired.map((entry) => entry.run.id);
      }),
    // Staff re-runs use fresh conversations and never import customer-visible history.
    history: () => Promise.resolve([]),
    latestScope: (scope) =>
      access(
        (entries) =>
          entries.filter((entry) => conversation(entry, scope)).at(-1)?.run
            .scope ?? null
      ),
    progress: (id, sessionId, progress) =>
      access((entries) => {
        const { run } = owned(entries, id);
        if (run.outcome || run.session_id !== sessionId) {
          return;
        }
        const previous = run.progress;
        if (progress.stage === "preparing" && previous) {
          run.progress = { ...previous, stage: "preparing" };
        } else if (
          !previous ||
          (previous.stage !== "preparing" &&
            previous.sequence < progress.sequence)
        ) {
          run.progress = widgetProgressSchema.parse(progress);
        }
      }),
    read: (id) => access((entries) => owned(entries, id).run),
    requestRecording: (id) =>
      access((entries) => {
        owned(entries, id).run.recording_requested = true;
      }),
  } satisfies Pick<
    WidgetDependencies,
    | "claim"
    | "read"
    | "latestScope"
    | "history"
    | "attach"
    | "claimFinish"
    | "complete"
    | "progress"
    | "cancel"
    | "requestRecording"
    | "expire"
    | "expireAll"
  >;
}

/** One composition boundary replaces every SQL binding, including lifecycle failure delivery. */
export function liveDependencies<T extends WidgetDependencies>(
  deps: T,
  directory?: string
): T {
  assertLiveAllowed();
  return process.env.WIDGET_LIVE === "1"
    ? { ...deps, ...liveRunStore(directory) }
    : deps;
}
