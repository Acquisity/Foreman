import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import type { z } from "zod";
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
 * Eval replay: with WIDGET_REPLAY_CASE naming a case file, every widget read
 * returns the case's recorded output instead of calling a provider, and the
 * widget identity and ownership checks answer from the case's fixture scope.
 * Models, Jev and the egress gate stay live. Never on production.
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
  if (env.WIDGET_REPLAY_CASE && env.VERCEL_ENV === "production") {
    throw new Error("WIDGET_REPLAY_CASE is not allowed on production.");
  }
}
// Every widget tool resolver imports this module, so production with the flag fails at boot.
assertReplayAllowed();

export const isReplayActive = () => {
  assertReplayAllowed();
  return Boolean(process.env.WIDGET_REPLAY_CASE);
};

const MAX_CASSETTE_CHARS = 1_048_576;
let loaded:
  | { case: WidgetCase; path: string; owned: OwnedIdentifiers }
  | undefined;
const reads = new Map<
  string,
  {
    schema: z.ZodType;
    outputs: Map<string, unknown>;
  }
>();
export function replayCase(): WidgetCase {
  const path = process.env.WIDGET_REPLAY_CASE ?? "";
  if (loaded?.path !== path) {
    const recorded = widgetCaseSchema.parse(
      JSON.parse(readFileSync(path, "utf8"))
    );
    const text = JSON.stringify(recorded.cassette);
    if (text.length > MAX_CASSETTE_CHARS) {
      throw new Error("Replay cassette exceeds the identifier scan bound.");
    }
    const { candidates } = scanIdentifiers(text);
    loaded = {
      case: recorded,
      owned: {
        domains: new Set(candidates.domains),
        emails: new Set(candidates.emails),
        slugs: new Set([
          ...candidates.slugs,
          fixture.organizationSlug.toLowerCase(),
        ]),
        uuids: new Set([
          ...candidates.uuids,
          fixture.organizationId,
          fixture.userId,
          fixture.partnerId,
          fixture.conversationId,
        ]),
      },
      path,
    };
    reads.clear();
  }
  return loaded.case;
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

/** The recorded output for this exact call, or the fixed miss result. */
export function replayRead(tool: string, input: unknown): unknown {
  const recorded = replayCase();
  const prepared = reads.get(tool);
  const key = lookupKey(tool, prepared ? prepared.schema.parse(input) : input);
  if (prepared?.outputs.has(key)) {
    return prepared.outputs.get(key);
  }
  const hit = prepared
    ? undefined
    : recorded.cassette.find(
        (entry) => lookupKey(entry.tool, entry.input) === key
      );
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
  if (!isReplayActive()) {
    return tool;
  }
  const { approval, description, inputSchema } = tool as T & {
    approval?: Parameters<typeof defineTool>[0]["approval"];
    inputSchema: z.ZodType;
  };
  const recorded = replayCase();
  if (reads.get(name)?.schema !== inputSchema) {
    const outputs = new Map<string, unknown>();
    for (const entry of recorded.cassette.filter(
      (candidate) => candidate.tool === name
    )) {
      const parsed = inputSchema.safeParse(entry.input);
      if (!parsed.success) {
        continue;
      }
      const key = lookupKey(name, parsed.data);
      if (!outputs.has(key)) {
        outputs.set(key, entry.output);
      }
    }
    reads.set(name, { outputs, schema: inputSchema });
  }
  return defineTool({
    approval,
    description,
    // No outputSchema: the miss result must reach the model as it is.
    execute: (input, ctx) => {
      // The authored tool's scope check, so a malformed widget session reads nothing.
      requireWidgetContext(ctx.session.auth.initiator);
      return replayRead(name, input);
    },
    inputSchema,
  }) as unknown as T;
}

/** The fixture scope in place of the app's token check. */
export function replayContext(input: {
  conversationId: string;
  organizationId: string;
  staff?: boolean;
}): WidgetContext {
  if (input.organizationId !== fixture.organizationId) {
    throw new Error("Replay serves the fixture workspace only.");
  }
  return Object.freeze(
    widgetContextSchema.parse({
      ...fixture,
      conversationId: input.conversationId,
      role: replayCase().scope.role,
      source: input.staff ? "inbox" : "widget",
    })
  );
}

/** Owned under replay: a candidate the cassette or the fixture scope itself contains. */
export function replayOwnership(
  candidates: IdentifierCandidates
): OwnedIdentifiers {
  replayCase();
  const known = loaded?.owned;
  if (!known) {
    throw new Error("Replay case is unavailable.");
  }
  const owned = (values: string[] | undefined, identifiers: Set<string>) =>
    new Set(
      (values ?? [])
        .map((value) => value.toLowerCase())
        .filter((value) => identifiers.has(value))
    );
  return {
    domains: owned(candidates.domains, known.domains),
    emails: owned(candidates.emails, known.emails),
    slugs: owned(candidates.slugs, known.slugs),
    uuids: owned(candidates.uuids, known.uuids),
  };
}

/** Restore the route's recording reference when the case contains its reader. */
export const replayRecording = (recorded: WidgetCase) =>
  recorded.cassette.some((entry) => entry.tool === "widget_read_recording")
    ? { id: "replay-recording" }
    : undefined;
