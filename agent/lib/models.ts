// One place to change every agent's model. Ids are Vercel AI Gateway strings (<provider>/<model>),
// so routing, credentials, and fallbacks stay on the gateway and no provider SDK is wired in.
// Each agent.ts reads its entry here (model: MODELS.<agent>) instead of hardcoding a string.
export const MODELS = {
  analyst: "deepseek/deepseek-v4-pro-0813",
  classifier: "deepseek/deepseek-v4-pro-0813",
  implementer: "deepseek/deepseek-v4-pro-0813",
  orchestrator: "deepseek/deepseek-v4-pro-0813",
  researcher: "deepseek/deepseek-v4-pro-0813",
  reviewer: "deepseek/deepseek-v4-pro-0813",
} as const;

export type FactoryAgent = keyof typeof MODELS;
