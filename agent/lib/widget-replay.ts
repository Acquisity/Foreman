import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import type { z } from "zod";
import { logOpsEvent } from "./ops-log.js";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import type {
  IdentifierCandidates,
  OwnedIdentifiers,
} from "./widget-evidence.js";
import { type WidgetContext, widgetContextSchema } from "./widget-scope.js";

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

let loaded: { case: WidgetCase; path: string } | undefined;
export function replayCase(): WidgetCase {
  const path = process.env.WIDGET_REPLAY_CASE ?? "";
  if (loaded?.path !== path) {
    loaded = {
      case: widgetCaseSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
      path,
    };
  }
  return loaded.case;
}

/** Inputs compare with object keys sorted at every depth and undefined fields dropped. */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
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
  const key = lookupKey(tool, input);
  const hit = replayCase().cassette.find(
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
  const { description, inputSchema } = tool as T & { inputSchema: z.ZodType };
  return defineTool({
    description,
    // No outputSchema: the miss result must reach the model as it is.
    execute: (input) => replayRead(name, input),
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
  const known =
    `${JSON.stringify(replayCase().cassette)} ${Object.values(fixture).join(" ")}`.toLowerCase();
  const owned = (values: string[] = []) =>
    new Set(values.filter((value) => known.includes(value.toLowerCase())));
  return {
    domains: owned(candidates.domains),
    emails: owned(candidates.emails),
    slugs: owned(candidates.slugs),
    uuids: owned(candidates.uuids),
  };
}
