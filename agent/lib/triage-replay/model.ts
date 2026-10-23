import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";

export const replayToolsMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: ({ params }) =>
    Promise.resolve({
      ...params,
      tools: params.tools?.filter((tool) => tool.type !== "provider"),
    }),
};

export const withoutProviderTools = (
  model: Parameters<typeof wrapLanguageModel>[0]["model"]
) => wrapLanguageModel({ middleware: replayToolsMiddleware, model });
