// One place to change every agent's model. Ids are Vercel AI Gateway strings (<provider>/<model>),
// so routing, credentials, and fallbacks stay on the gateway and no provider SDK is wired in.
// Each agent.ts reads its entry here (model: MODELS.<agent>) instead of hardcoding a string.
export const MODELS = {
  analyst: "openai/gpt-5.6-terra-fast",
  classifier: "openai/gpt-5.6-terra-fast",
  implementer: "deepseek/deepseek-v4-pro-0813", // the station that writes the code gets the strongest coding model we can run unthrottled; claude-fable-5 is rate-capped on the shared gateway pool
  orchestrator: "openai/gpt-5.6-terra-fast",
  researcher: "openai/gpt-5.6-terra-fast",
  reviewer: "openai/gpt-5.6-terra-fast", // different vendor than implementer on purpose: independent review
} as const;

export type FactoryAgent = keyof typeof MODELS;
