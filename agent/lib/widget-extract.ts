import { gateway, generateObject } from "ai";
import { resolveModel } from "./models.js";
import {
  findingsSchema,
  parseFindings,
  type WidgetFindings,
} from "./widget-findings.js";
import type { WidgetContext } from "./widget-scope.js";

const EXTRACT_PROMPT = `You convert an internal support investigator's free-form findings into a structured object. You receive the customer's question and the investigator's written findings. Produce: facts (each a claim, the tool or record it cited in evidence, and any identifiers it named in entityIds), a recommendation, confidence (low, medium or high), needsHuman (true when the investigator said a person should take over or could not verify the answer), needsWrite when a change is required that could not be made, ticket only if the investigator filed one (an ENG-#### id and its url), and report (the investigator's plain-English summary for a teammate, at most 1000 characters). Copy faithfully from the investigator's text: never invent a fact, identifier, evidence reference, link or ticket the investigator did not state. If the investigator gave no usable findings, set needsHuman true, facts to an empty array, and put whatever they did say into recommendation and report.`;

export interface ExtractInput {
  investigatorText: string;
  question: string;
  scope: WidgetContext;
}
export interface ExtractDeps {
  generate: (input: ExtractInput) => Promise<unknown>;
}

export const defaultExtractDeps: ExtractDeps = {
  async generate({ investigatorText, question, scope }) {
    const { object } = await generateObject({
      model: gateway(await resolveModel("gate")),
      prompt: JSON.stringify({
        findings: investigatorText,
        question,
        workspace: scope.organizationName,
      }),
      schema: findingsSchema,
      system: EXTRACT_PROMPT,
    });
    return object;
  },
};

/**
 * One small-model pass turns the investigator's prose into validated findings.
 * The investigator no longer emits the strict schema itself, so a normal
 * write-up can never fail the session; this step reformats it and returns null
 * when it cannot, leaving the caller to hand the prose to a human.
 */
export async function extractWidgetFindings(
  input: ExtractInput,
  deps: ExtractDeps = defaultExtractDeps
): Promise<WidgetFindings | null> {
  if (!input.investigatorText.trim()) {
    return null;
  }
  try {
    return parseFindings(await deps.generate(input));
  } catch {
    return null;
  }
}
