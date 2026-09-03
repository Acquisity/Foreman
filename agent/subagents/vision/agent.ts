import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "../../lib/models.js";

/**
 * Vision sidecar.
 *
 * @remarks
 * A screenshot handed to the calling model as a content part is persisted in
 * session history and re-sent on every later model call, so the orchestrator
 * pays for it on every turn that follows. This station reads the pixels on a
 * cheap vision model and returns text: the image lives only in the child's
 * session, which is discarded when the task returns.
 *
 * The caller passes its actual question. Targeted extraction is where small
 * vision models hold up; open-ended captioning is not. Anything needing
 * pixel-precise coordinates, or the same image reasoned over across many
 * turns, still wants the image in the calling model's own context.
 */
export default defineAgent({
  description:
    "Read an image in the sandbox and answer a specific question about it. Pass the file path and exactly what you need to know, for example whether a button is disabled and what the error text says. A file attached in Slack is already staged under /workspace/attachments, and that staged path is what to pass. Returns findings as text, never pixels, so the image never enters your history. Not for pixel-precise coordinates.",
  model: defineDynamic({
    events: { "session.started": () => resolveModel("vision") },
  }),
  outputSchema: {
    additionalProperties: false,
    properties: {
      answer: {
        description:
          "The answer to the question that was asked, and nothing else.",
        type: "string",
      },
      uncertainties: {
        description:
          "What could not be read with confidence: cropped, blurred, ambiguous, or absent from the image.",
        items: { type: "string" },
        type: "array",
      },
      visible_text: {
        description:
          "Text transcribed from the image that bears on the question, verbatim.",
        items: { type: "string" },
        type: "array",
      },
    },
    required: ["answer", "visible_text", "uncertainties"],
    type: "object",
  },
});
