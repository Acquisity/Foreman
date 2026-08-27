import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { denyUnattendedWrites } from "#lib/github/approval.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import {
  DOCUMENT_MAX_CHARS,
  saveInvestigationDocument,
} from "#lib/linear-api.js";

/** 13 to 19 digits with optional separators; only a Luhn-valid run counts as a card number. */
const DIGIT_RUN = /\b(?:\d[ -]?){12,18}\d\b/gu;
const SEPARATORS = /[ -]/gu;

const luhnValid = (digits: string) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * Whether `text` carries a Luhn-valid 13 to 19 digit run. Input is bounded, so the scan is too.
 * ponytail: Luhn still passes about one random digit run in ten; add issuer prefixes if a real id keeps tripping it.
 */
export const hasCardNumber = (text: string) =>
  (text.match(DIGIT_RUN) ?? []).some((run) =>
    luhnValid(run.replace(SEPARATORS, ""))
  );
/** Two letters, two check digits, 11 to 30 alphanumerics, any case, spaces or dashes allowed: an IBAN. */
const IBAN = /\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}\b/u;

export default defineTool({
  approval: denyUnattendedWrites("Linear"),
  description:
    "Create or rewrite the one issue-scoped investigation document for a ticket: lane triage writes `Triage investigation`, lane billing writes `Billing investigation`. " +
    "Send the whole document each time; the first call creates it and later calls replace its content, never a second document. " +
    "Returns documentId and updatedAt, which is the version pin the critic packet needs, plus the url for the ticket comment. " +
    "Do not call this in a read-only validation run.",
  async execute(input, ctx) {
    if (
      input.lane === "billing" &&
      (hasCardNumber(input.content) || IBAN.test(input.content))
    ) {
      return {
        error:
          "The document contains a card or bank account number. Remove it; ids, amounts, and dates are enough.",
        saved: false as const,
      };
    }
    try {
      const { token } = await ctx.getToken(linearAuth);
      const result = await saveInvestigationDocument(token, input, {
        signal: ctx.abortSignal,
      });
      return { saved: true as const, ...result };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error:
          error instanceof Error ? error.message : "Document write failed.",
        saved: false as const,
      };
    }
  },
  inputSchema: z.object({
    content: z
      .string()
      .min(1)
      .max(DOCUMENT_MAX_CHARS)
      .describe("The full Markdown document, from the lane's template."),
    issue: z
      .string()
      .trim()
      .regex(LINEAR_ISSUE_ID_PATTERN)
      .describe("Issue identifier, such as ENG-123."),
    lane: z.enum(["triage", "billing"]),
  }),
  outputSchema: z.object({
    created: z.boolean().optional(),
    documentId: z.string().optional(),
    /** With saved true: the write landed but updatedAt could not be read back. With saved false: nothing was written. */
    error: z.string().optional(),
    saved: z.boolean(),
    updatedAt: z.string().optional(),
    url: z.string().optional(),
  }),
});
