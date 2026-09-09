import { gateway, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { linkTickets } from "./ticket-links.js";

/** Format model text before eve records or delivers it, including its raw HTTP stream. */
export const ticketLinkMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.map((part) =>
        part.type === "text" ? { ...part, text: linkTickets(part.text) } : part
      ),
    };
  },
  async wrapStream({ doStream }) {
    const result = await doStream();
    type StreamPart =
      typeof result.stream extends ReadableStream<infer Part> ? Part : never;
    const text = new Map<string, string>();
    const flushText = (
      controller: TransformStreamDefaultController<StreamPart>
    ) => {
      for (const [id, value] of text) {
        if (value) {
          controller.enqueue({
            delta: linkTickets(value),
            id,
            type: "text-delta",
          });
        }
      }
      text.clear();
    };
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          flush: flushText,
          transform(part, controller) {
            if (part.type === "text-start") {
              text.set(part.id, "");
            } else if (part.type === "text-delta") {
              text.set(part.id, (text.get(part.id) ?? "") + part.delta);
              if (part.providerMetadata) {
                controller.enqueue({ ...part, delta: "" });
              }
              return;
            } else if (part.type === "text-end") {
              const value = text.get(part.id);
              if (value) {
                controller.enqueue({
                  delta: linkTickets(value),
                  id: part.id,
                  type: "text-delta",
                });
              }
              text.delete(part.id);
            } else if (part.type === "finish") {
              flushText(controller);
            }
            controller.enqueue(part);
          },
        })
      ),
    };
  },
};

export const ticketLinkedModel = (id: string) =>
  wrapLanguageModel({
    middleware: ticketLinkMiddleware,
    model: gateway(id),
  });
