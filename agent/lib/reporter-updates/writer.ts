import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { modelFor, resolveModel } from "../models.js";
import { logOpsEvent, type OpsFields } from "../ops-log.js";

export const WRITER_TIMEOUT_MS = 20_000;
const MAX_INPUT_CHARS = 3000;
const MAX_COMMENTS = 5;

export type WriterTask =
  | { description: string; kind: "received"; title: string }
  | {
      description: string;
      kind: "fixed" | "live";
      pull: string;
      title: string;
    }
  | { comments: string[]; kind: "done" | "reason"; title: string };

export interface WriterReply {
  asDesigned?: boolean | null;
  steps: string | null;
  what: string | null;
}

export type ReporterWriter = (task: WriterTask) => Promise<WriterReply>;

export const NO_REPLY: WriterReply = {
  asDesigned: null,
  steps: null,
  what: null,
};

const replySchema = z.object({
  asDesigned: z.boolean().nullable(),
  steps: z.string().max(400).nullable(),
  what: z.string().max(300).nullable(),
});

const RULES = [
  "You write part of a short Slack message to a customer who reported a problem or asked for something in our product.",
  "Write in plain, friendly words a customer uses. Never mention developers, owners, names of staff, tickets, pull requests, code, merges, deploys, file paths, error codes or AI models.",
  "No markdown, no quotes, no links, no emoji and no em dashes.",
  "Say only what the text below supports. Never invent a change, a button or a page.",
  "Return JSON with three fields, what, steps and asDesigned. Use null for a field you cannot write from the text, and for asDesigned unless the task asks for it.",
].join("\n");

const TASKS: Record<WriterTask["kind"], string> = {
  done: [
    "The report was closed with no code change. Read the closing comments from our team.",
    "If a person clearly says they made a change for this customer, such as fixing their data, removing a record or changing a setting, set what to a phrase of at most 15 words saying what was done, as it fits after 'Done: ', for example: that number's been removed from the CRM.",
    "If no comment clearly describes a change that was made, set what to null. When in doubt, use null.",
    "Set steps to null.",
  ].join("\n"),
  fixed: [
    "A bug fix for this report is now live.",
    "Set what to a phrase of at most 15 words saying what works now, as it fits after 'Fixed: ', for example: the Resume session card no longer blocks your search bar.",
    "If the change description tells a user something they should do or know, set steps to one or two short sentences, at most 25 words, naming the button, page or menu. Otherwise set steps to null.",
  ].join("\n"),
  live: [
    "A new feature for this request is now live.",
    "Set what to a phrase of at most 15 words saying what the customer can now do, as it fits after 'This is live: ', for example: you can now send an email without leaving the power dialler.",
    "Set steps to one or two short sentences, at most 25 words, telling the customer how to use it and where to find it on screen, naming the button, page or menu, for example: After a call, click Email in the wrap-up panel, next to Task, Text and Book meeting.",
  ].join("\n"),
  reason: [
    "The report was closed without a change. Read the closing comments from our team.",
    "Set asDesigned to true when they found the product works the way it is meant to: the customer's expectation differs from how it works, a user mistake, or a current limitation of the product. Set it to false when they decided not to change it for any other reason, such as not planned, out of scope or could not reproduce. Use null when the comments do not say.",
    "If they give a reason a customer would understand, set what to that reason in at most 10 words, as it fits after a colon at the end of a sentence, for example: exports only include the last 12 months.",
    "Otherwise set what to null. Set steps to null.",
  ].join("\n"),
  received: [
    "We have just received this report.",
    "Set what to a phrase of at most 15 words naming the problem or request, as it fits after 'We're looking into ', for example: why your email threads won't load.",
    "Set steps to null.",
  ].join("\n"),
};

const clip = (text: string): string => text.slice(0, MAX_INPUT_CHARS);

const contextOf = (task: WriterTask): string => {
  const parts = [`Report title: ${clip(task.title)}`];
  if ("comments" in task) {
    const comments = task.comments.slice(-MAX_COMMENTS).map(clip);
    parts.push(
      comments.length > 0
        ? `Closing comments from our team:\n${comments.map((comment) => `- ${comment}`).join("\n")}`
        : "Closing comments from our team: none"
    );
    return parts.join("\n\n");
  }
  parts.push(`Report description:\n${clip(task.description)}`);
  if ("pull" in task) {
    parts.push(`What the change does:\n${clip(task.pull)}`);
  }
  return parts.join("\n\n");
};

export const writerPrompt = (task: WriterTask): string =>
  `${RULES}\n\n${TASKS[task.kind]}\n\n${contextOf(task)}`;

/**
 * Writes the short phrases inside a reporter update on the `writer` slot, with
 * a strict output schema and a timeout. Any failure returns `NO_REPLY` and logs
 * `reporter.update.writer_failed`, so the caller posts its fallback line, or
 * nothing for a done-without-change judgement. The caller still checks every
 * phrase for length and banned words.
 */
export const reporterWriter =
  (
    model?: LanguageModel,
    timeoutMs: number = WRITER_TIMEOUT_MS,
    log: (event: string, fields: OpsFields) => void = logOpsEvent
  ): ReporterWriter =>
  async (task) => {
    try {
      const { output } = await generateText({
        abortSignal: AbortSignal.timeout(timeoutMs),
        model: model ?? modelFor(await resolveModel("writer")),
        output: Output.object({ schema: replySchema }),
        prompt: writerPrompt(task),
      });
      return output;
    } catch (error) {
      log("reporter.update.writer_failed", {
        code: error instanceof Error ? error.name : "unknown",
        decision: task.kind,
        outcome: "error",
      });
      return NO_REPLY;
    }
  };
