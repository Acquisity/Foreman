import { z } from "zod";
import { runClaudeJson, withClaudeSlot } from "../claude-headless.js";
import type { TriageLabel, TriageResult } from "./schema.js";

/**
 * The triage replay's root-cause judge (ENG-16049). Like the widget claims
 * judge it runs through headless Claude Code on the local login (`claude -p
 * --model opus`), never the AI Gateway, with no tools and its own schema.
 */

const CLAUDE_MODEL = "opus";
export const JUDGE_MODEL = `claude-code/${CLAUDE_MODEL}`;
/** A headless Claude Code start plus an Opus answer on a large input. */
export const JUDGE_TIMEOUT_MS = 240_000;
/** The run's document is cut here; triage documents are far shorter. */
const MAX_DOCUMENT = 40_000;
const MAX_REASON = 240;
const WHITESPACE = /\s+/g;

/** The judge's reply: one grade and a one-sentence reason. */
export const rootCauseVerdictSchema = z.strictObject({
  grade: z.enum(["match", "partial", "wrong"]),
  reason: z.string().min(1),
});
/** A parsed judge verdict. */
export type RootCauseVerdict = z.infer<typeof rootCauseVerdictSchema>;

const { $schema: _draft, ...verdictJsonSchema } = z.toJSONSchema(
  rootCauseVerdictSchema
);
const VERDICT_JSON_SCHEMA = JSON.stringify(verdictJsonSchema);

/** The judge's system prompt: for a code fix, where first, then why; for a non-bug closure, the person's explanation. */
export const ROOT_CAUSE_PROMPT = `You grade whether a triage run found the real root cause of one ticket.

The input is JSON. "label" is the human-settled cause. Its "kind" is "code_fix" when a merged fix settled it: the files and functions the fix changed, then a short text. Its "kind" is "non_bug" when a person confirmed the ticket was not a bug (a user error, a platform limit, an unpaid or expired account): "files" and "functions" are empty and "text" is the person's explanation. "run" is what the triage run wrote: its investigation document and its final routing decision.

For a code_fix, judge where first, then why. The run must name the same place in the code as the label's files and functions (a caller or the same module counts as the same place only when the document ties it to the same defect), and the same mechanism as the label's text.

For a non_bug, there is no place in the code. The run must give the same explanation as the label's text: the same user action, account state or platform limit. A run that calls it a bug and names a code defect is wrong, even if the ticket's symptom is described correctly.

- match: same place and same mechanism for a code_fix; the same explanation for a non_bug.
- partial: for a code_fix, the right place with a wrong or missing mechanism, or the right mechanism placed in the wrong code; for a non_bug, the right kind of explanation (such as non-payment) without the specific fact the label names.
- wrong: neither, a different defect or explanation, or no cause stated.

Grade only what the document says, not what it could have meant. Reply with the grade and one short sentence of reason.`;

/** The judge's input: the label's root cause against the run's document and final decision. */
export function rootCausePrompt(
  label: TriageLabel,
  result: Pick<TriageResult, "document" | "final">
): string {
  if (!label.rootCause) {
    throw new Error(`${label.id} has no labelled root cause to judge.`);
  }
  const { files, functions, text } = label.rootCause;
  return JSON.stringify({
    label: {
      files,
      functions,
      kind:
        files.length === 0 && functions.length === 0 ? "non_bug" : "code_fix",
      text,
    },
    run: {
      document: result.document?.text.slice(0, MAX_DOCUMENT) ?? null,
      final: result.final,
    },
  });
}

/** The judge's reply held to the schema, its reason one bounded line. */
export function parseRootCauseVerdict(raw: unknown): RootCauseVerdict {
  const verdict = rootCauseVerdictSchema.parse(raw);
  return {
    grade: verdict.grade,
    reason: verdict.reason.replace(WHITESPACE, " ").trim().slice(0, MAX_REASON),
  };
}

/** One judge call: system prompt and input in, the structured object out. */
export type RootCauseRunner = (
  system: string,
  input: string,
  signal: AbortSignal
) => Promise<unknown>;

export const claudeRootCauseJudge: RootCauseRunner = (system, input, signal) =>
  runClaudeJson({
    input,
    jsonSchema: VERDICT_JSON_SCHEMA,
    model: CLAUDE_MODEL,
    signal,
    system,
  });

/**
 * A root-cause judge capped at `maxCalls`. Each call takes one of the `claude
 * -p` slots it shares with the widget judge, and its own four-minute deadline
 * once the slot is free; the call past the cap throws before it starts.
 */
export function rootCauseJudge(
  maxCalls: number,
  run: RootCauseRunner = claudeRootCauseJudge
) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0) {
    throw new Error(`maxCalls must be a whole number, got ${maxCalls}.`);
  }
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async judge(
      label: TriageLabel,
      result: Pick<TriageResult, "document" | "final">
    ): Promise<RootCauseVerdict> {
      if (calls >= maxCalls) {
        throw new Error(
          `Root-cause judge cap of ${maxCalls} call(s) exceeded at ${label.id}.`
        );
      }
      calls += 1;
      const input = rootCausePrompt(label, result);
      return await withClaudeSlot(async () =>
        parseRootCauseVerdict(
          await run(
            ROOT_CAUSE_PROMPT,
            input,
            AbortSignal.timeout(JUDGE_TIMEOUT_MS)
          )
        )
      );
    },
  };
}
