import { generateText, type LanguageModel } from "ai";
import { modelFor, resolveModel } from "./models.js";

/** A full investigation document is up to 20,000 characters; this covers its rewrite. */
const WRITER_TIMEOUT_MS = 90_000;

const WRITER_PROMPT = `Rewrite the text below so it reads clearly to the person it is for. Change only the wording.
Keep every fact, number, id, amount, date, URL, name, Markdown heading and the Markdown structure exactly. Do not add, drop or soften any claim.
Use plain language, no em dashes, and no bold for emphasis.
Return only the rewritten text.`;

/**
 * Rewords a triage-intake session's requester reply or investigation document
 * on the `writer` slot before it is posted (ENG-15226). Opus drafts; the
 * writer only changes wording. Fails open: an error, a timeout, an empty
 * result, an incomplete finish, or one longer than `maxChars` returns the
 * draft unchanged. A cancelled turn still throws.
 */
export async function rewriteDraft(
  draft: string,
  maxChars: number,
  signal: AbortSignal,
  model?: LanguageModel
): Promise<string> {
  try {
    const { finishReason, text } = await generateText({
      abortSignal: AbortSignal.any([
        signal,
        AbortSignal.timeout(WRITER_TIMEOUT_MS),
      ]),
      model: model ?? modelFor(await resolveModel("writer")),
      prompt: `${WRITER_PROMPT}\n\n${draft}`,
    });
    const rewritten = text.trim();
    return finishReason === "stop" && rewritten && rewritten.length <= maxChars
      ? rewritten
      : draft;
  } catch {
    signal.throwIfAborted();
    return draft;
  }
}
