/**
 * Progress lines for long-running Slack turns. A turn still running at 5 and
 * 15 minutes gets one short line at each threshold and never a third: the
 * thresholds are indexed by how many lines the turn has already posted, so
 * two posted lines retire the helper for that turn no matter how long it
 * runs. The decision is pure; channel handlers own the state writes and the
 * posting.
 */

/** Elapsed-turn thresholds at which a progress line is due. */
export const SLACK_PROGRESS_THRESHOLDS_MS = [300_000, 900_000] as const;

/** Bound on the wait label so a progress line stays one short line. */
export const SLACK_PROGRESS_LABEL_LIMIT = 80;

/**
 * Per-turn progress tracking carried in the Slack channel state. All fields
 * are scalars, so the state round-trips through the JSON persistence eve
 * requires of channel state.
 */
export interface SlackProgressState {
  /** Progress lines already posted for this turn. */
  readonly posts: number;
  /** Turn start time in epoch milliseconds. */
  readonly startedAtMs: number;
  /** Tool calls the turn has made so far. */
  readonly toolCalls: number;
  /** Short label for what the turn is currently waiting on, if known. */
  readonly waitLabel: string | null;
}

declare module "eve/channels/slack" {
  interface SlackChannelState {
    /** Per-turn progress state for the 5/15-minute lines. */
    progress?: SlackProgressState;
  }
}

/**
 * Collapses every run of whitespace or control characters to one space so a
 * label can never turn the promised single progress line into several.
 */
const normalizeLabel = (label: string): string =>
  label.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();

/**
 * Bounds the label at the code-unit limit without splitting a UTF-16
 * surrogate pair: a cut landing after a lone high surrogate backs off one
 * code unit so no corrupted replacement character reaches Slack.
 */
const truncateLabel = (label: string): string => {
  if (label.length <= SLACK_PROGRESS_LABEL_LIMIT) {
    return label;
  }
  let end = SLACK_PROGRESS_LABEL_LIMIT;
  const lastCode = label.charCodeAt(end - 1);
  if (lastCode >= 0xd8_00 && lastCode <= 0xdb_ff) {
    end -= 1;
  }
  return `${label.slice(0, end)}...`;
};

/**
 * Structural projection of eve's `RuntimeActionResult` union, carrying only
 * the name each result kind reports. Keeping the projection local leaves the
 * helper pure and testable without importing runtime internals.
 */
export type SlackProgressActionResult =
  | { readonly kind: "tool-result"; readonly toolName: string }
  | { readonly kind: "subagent-result"; readonly subagentName: string }
  | { readonly kind: "load-skill-result"; readonly name?: string | undefined };

/**
 * Derives the short wait label a finished action leaves behind: the tool or
 * subagent name, or null when the result names nothing (a skill load that
 * activated no skill). Channel handlers feed this into the state's
 * `waitLabel`; the decision helper bounds and normalizes it.
 */
export const slackProgressActionLabel = (
  result: SlackProgressActionResult
): string | null => {
  if (result.kind === "tool-result") {
    return result.toolName;
  }
  if (result.kind === "subagent-result") {
    return result.subagentName;
  }
  return result.name ?? null;
};

/**
 * Structural projection of eve's `RuntimeActionRequest` union, carrying only
 * the name each requested action kind reports. Same rationale as
 * {@link SlackProgressActionResult}.
 */
export type SlackProgressActionRequest =
  | { readonly kind: "tool-call"; readonly toolName: string }
  | { readonly kind: "subagent-call"; readonly subagentName: string }
  | { readonly kind: "remote-agent-call"; readonly remoteAgentName: string }
  | { readonly kind: "load-skill" };

/**
 * Derives the wait label for a batch of requested actions from the first
 * one: the tool, subagent, or remote agent the turn is about to wait on, or
 * null for an empty batch or a bare skill load. Channel handlers feed this
 * into the state's `waitLabel` when the model requests actions.
 */
export const slackProgressActionRequestLabel = (
  actions: readonly SlackProgressActionRequest[]
): string | null => {
  const [first] = actions;
  if (!first || first.kind === "load-skill") {
    return null;
  }
  if (first.kind === "tool-call") {
    return first.toolName;
  }
  if (first.kind === "subagent-call") {
    return first.subagentName;
  }
  return first.remoteAgentName;
};

/**
 * Returns the progress line due at `nowMs`, or null when none is due: no
 * state, the next threshold not yet reached, or both lines already posted.
 * The posted-line count selects the threshold, so a turn can never produce
 * more than two lines.
 */
export const decideSlackProgressLine = (
  state: SlackProgressState | null | undefined,
  nowMs: number
): string | null => {
  if (!state) {
    return null;
  }
  const threshold = SLACK_PROGRESS_THRESHOLDS_MS[state.posts];
  if (threshold === undefined || nowMs - state.startedAtMs < threshold) {
    return null;
  }
  const minutes = threshold / 60_000;
  const label = state.waitLabel ? normalizeLabel(state.waitLabel) : "";
  const waiting = label ? ` Currently waiting on ${truncateLabel(label)}.` : "";
  return `Still working: ${minutes} minutes in, ${state.toolCalls} tool calls so far.${waiting}`;
};
