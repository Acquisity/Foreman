import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import { scanIdentifiers } from "./widget-egress.js";
import type {
  IdentifierCandidates,
  OwnedIdentifiers,
} from "./widget-evidence.js";
import {
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "./widget-scope.js";

/**
 * Eval replay: with WIDGET_REPLAY=1 and a case id stamped on each session, every widget read
 * returns the case's recorded output instead of calling a provider, and the
 * widget identity and ownership checks answer from the case's fixture scope.
 * Models and the egress gate stay live. Never on production.
 */
export const REPLAY_MISS = Object.freeze({
  message: "No data recorded for this read.",
  replay: "miss",
  status: "unavailable",
});
/** widget_file_ticket with no recorded output: the call is in the stream, nothing is filed. */
export const REPLAY_TICKET = Object.freeze({
  filed: false,
  replay: "recorded",
});

/** Throws when the replay flag is set on a production deployment. */
export function assertReplayAllowed(env: NodeJS.ProcessEnv = process.env) {
  if (
    (env.WIDGET_REPLAY === "1" ||
      env.WIDGET_REPLAY_CASE ||
      env.WIDGET_LIVE_CASE) &&
    env.VERCEL_ENV === "production"
  ) {
    throw new Error("Widget replay is not allowed on production.");
  }
}
// Every widget tool resolver imports this module, so production with the flag fails at boot.
assertReplayAllowed();

export const isReplayActive = () => {
  assertReplayAllowed();
  return (
    process.env.WIDGET_REPLAY === "1" || Boolean(process.env.WIDGET_REPLAY_CASE)
  );
};

/**
 * Live replay: WIDGET_LIVE_CASE names a gitignored file under .eve/widget-live/
 * holding one production run's real question and verified scope, written by
 * `pnpm widget:case --live`. The route answers identity from that scope, every
 * read hits production live, and widget_file_ticket files nothing. Never on production.
 */
export const LIVE_DIR = ".eve/widget-live";
const liveCaseSchema = z.object({
  context: widgetContextSchema,
  question: z.string().min(1),
  runId: z.string(),
});
export type LiveCase = z.infer<typeof liveCaseSchema> & { name: string };
export function liveCase(): LiveCase | null {
  const path = process.env.WIDGET_LIVE_CASE;
  if (!path) {
    return null;
  }
  assertReplayAllowed();
  if (dirname(path) !== LIVE_DIR || !path.endsWith(".json")) {
    throw new Error(`WIDGET_LIVE_CASE must be a file in ${LIVE_DIR}.`);
  }
  return {
    ...liveCaseSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
    name: basename(path, ".json"),
  };
}

/** The live run's verified scope in place of the app's token check. */
export function liveContext(
  live: LiveCase,
  input: { conversationId: string; organizationId: string; staff?: boolean }
): WidgetContext {
  if (input.organizationId !== live.context.organizationId) {
    throw new Error("Live replay serves the recorded run's workspace only.");
  }
  return Object.freeze(
    widgetContextSchema.parse({
      ...live.context,
      conversationId: input.conversationId,
      source: input.staff ? "inbox" : "widget",
      verifiedAt: new Date().toISOString(),
    })
  );
}

const MAX_CASSETTE_CHARS = 1_048_576;
const schemas = new Map<string, z.ZodType>();
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const casePath = (caseId?: string) => {
  if (!caseId) {
    return process.env.WIDGET_REPLAY_CASE ?? "";
  }
  if (!CASE_ID.test(caseId)) {
    throw new Error("Invalid replay case id.");
  }
  return `evals/widget/cases/${caseId}.json`;
};
export function replayCase(caseId?: string): WidgetCase {
  const text = readFileSync(casePath(caseId), "utf8");
  if (text.length > MAX_CASSETTE_CHARS) {
    throw new Error("Replay case exceeds the identifier scan bound.");
  }
  return widgetCaseSchema.parse(JSON.parse(text));
}

/** Inputs compare with object keys sorted at every depth and null or undefined fields dropped, so `{}` and `{ id: null }` are one call. */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined && child !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return value;
};
const lookupKey = (tool: string, input: unknown) =>
  JSON.stringify([tool, normalize(input)]);
/**
 * Free-text search fields the model rewords on every run. A call that differs from a
 * recording of the same tool only in these replays that recording; every other field
 * (ids, dates, urls) must still match exactly.
 */
const FREE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  widget_help_article: ["query"],
  widget_known_issues: ["query"],
};
const withoutFreeText = (tool: string, input: unknown) => {
  const fields = Object.hasOwn(FREE_TEXT_FIELDS, tool)
    ? FREE_TEXT_FIELDS[tool]
    : undefined;
  if (!(fields && input && typeof input === "object")) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !fields.includes(key))
  );
};

/** The recorded output for this exact call, else for the same call with reworded free text, else the fixed miss result. */
export function replayRead(
  tool: string,
  input: unknown,
  caseId?: string
): unknown {
  const recorded = replayCase(caseId);
  const schema = schemas.get(tool);
  const parsedInput = schema ? schema.parse(input) : input;
  const recordings = recorded.cassette.flatMap((entry) => {
    if (entry.tool !== tool) {
      return [];
    }
    const parsed = schema?.safeParse(entry.input);
    if (parsed && !parsed.success) {
      return [];
    }
    return [
      { input: parsed ? parsed.data : entry.input, output: entry.output },
    ];
  });
  const key = lookupKey(tool, parsedInput);
  const looseKey = lookupKey(tool, withoutFreeText(tool, parsedInput));
  const hit =
    recordings.find((entry) => lookupKey(tool, entry.input) === key) ??
    (Object.hasOwn(FREE_TEXT_FIELDS, tool)
      ? recordings.find(
          (entry) =>
            lookupKey(tool, withoutFreeText(tool, entry.input)) === looseKey
        )
      : undefined);
  if (hit) {
    return hit.output;
  }
  if (tool === "widget_file_ticket") {
    return REPLAY_TICKET;
  }
  logOpsEvent("widget.replay.miss", { outcome: "error", tool }, console.warn);
  return REPLAY_MISS;
}

/** The authored tool, or under replay a same-named tool that reads the cassette. */
export function replayable<T extends { description: string }>(
  name: string,
  tool: T
): T {
  const { description, inputSchema } = tool as T & { inputSchema: z.ZodType };
  if (!isReplayActive()) {
    // Live replay reads production but never files a real ticket.
    return name === "widget_file_ticket" && liveCase()
      ? (defineTool({
          description,
          execute: () => REPLAY_TICKET,
          inputSchema,
        }) as unknown as T)
      : tool;
  }
  schemas.set(name, inputSchema);
  // Only inline callbacks here: eve drops a tool whose forwarded authored
  // callback (such as its approval) is not stamped at this call site.
  return defineTool({
    description,
    // No outputSchema: the miss result must reach the model as it is.
    // Stricter than the authored issuer-only approval: a widget session without a verified scope reads nothing.
    execute: (input, ctx) =>
      replayRead(
        name,
        input,
        requireWidgetContext(ctx.session?.auth.initiator).replayCaseId
      ),
    inputSchema,
  }) as unknown as T;
}

/** The fixture scope in place of the app's token check. */
export function replayContext(input: {
  conversationId: string;
  organizationId: string;
  staff?: boolean;
  replayCaseId?: string;
}): WidgetContext {
  if (input.organizationId !== fixture.organizationId) {
    throw new Error("Replay serves the fixture workspace only.");
  }
  return Object.freeze(
    widgetContextSchema.parse({
      ...fixture,
      conversationId: input.conversationId,
      replayCaseId: input.replayCaseId,
      role: replayCase(input.replayCaseId).scope.role,
      source: input.staff ? "inbox" : "widget",
    })
  );
}

/** Owned under replay: a candidate the cassette or the fixture scope itself contains. */
export function replayOwnership(
  candidates: IdentifierCandidates,
  caseId?: string
): OwnedIdentifiers {
  const { candidates: known } = scanIdentifiers(
    JSON.stringify(replayCase(caseId).cassette)
  );
  const owned = (values: string[] | undefined, identifiers: Set<string>) =>
    new Set(
      (values ?? [])
        .map((value) => value.toLowerCase())
        .filter((value) => identifiers.has(value))
    );
  return {
    domains: owned(candidates.domains, new Set(known.domains)),
    emails: owned(candidates.emails, new Set(known.emails)),
    slugs: owned(
      candidates.slugs,
      new Set([...known.slugs, fixture.organizationSlug.toLowerCase()])
    ),
    uuids: owned(
      candidates.uuids,
      new Set([
        ...known.uuids,
        fixture.organizationId,
        fixture.userId,
        fixture.partnerId,
        fixture.conversationId,
      ])
    ),
  };
}

/** Restore the route's recording reference when the case contains its reader. */
export const replayRecording = (recorded: WidgetCase) =>
  recorded.cassette.some((entry) => entry.tool === "widget_read_recording")
    ? { id: "replay-recording" }
    : undefined;
