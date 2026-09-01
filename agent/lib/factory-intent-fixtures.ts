// The behaviour matrix for `isFactoryRequest`, shared by every test that runs
// it: the unit tests in `factory-lane.test.ts` and the real channel dispatches
// in `factory-lane.test.ts` and `slack-channel.test.ts`. One list, so a lane
// cannot quietly disagree with another about what a request is.

export const FACTORY_REQUESTS = [
  "please run the factory",
  "use factory mode for this",
  "Factory this one",
  "the factory, please",
  "run the factory on this",
  "Use FACTORY mode please",
  "take this through the factory.",
  // A clause that closes before the request does not reach into it.
  "not urgent. use the factory",
  "no rush; run the factory",
  "do not use direct mode, use factory",
  "no problem, run the factory",
] as const;

export const NOT_FACTORY_REQUESTS = [
  // A slug, a path, or a filename that merely carries the word.
  "Acquisity/Foreman",
  "factory/repo",
  "owner/factory",
  "channels/factory.ts",
  "factory-tools/repo",
  "factory-pipeline/repo",
  "factory-pipeline.ts",
  "agent/skills/factory-pipeline.ts",
  "see agent/lib/factory-lane.ts",
  "look at owner/factory and channels/factory.ts",
  // A longer word that starts or ends with it, in any script.
  "factoryé",
  "refactory",
  "factories",
  "refactoring the intake handler",
  // Ordinary work.
  "please fix the failing billing test",
  "",
  // A negator attached to the request itself.
  "do not use factory",
  "don't use the factory",
  "no factory please",
  "skip the factory",
  "skip the factory on this one",
  "don't run this through the factory",
  "fix it directly, without the factory",
] as const;
