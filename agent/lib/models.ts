import { createHash } from "node:crypto";
import { gateway } from "ai";
import { z } from "zod";
import { MODEL_OVERRIDES_PREFIX, readDocument, writeDocument } from "./blob.js";
import { FACTORY_REPO } from "./constants.js";

// One place to change every agent's model. Ids are Vercel AI Gateway strings (<provider>/<model>),
// so routing, credentials, and fallbacks stay on the gateway and no provider SDK is wired in.
// These are the compiled defaults; a live override saved by set_factory_models wins over them.
// Each agent.ts resolves its model through resolveModel(<agent>) at session start. The chat slot
// is the orchestrator's Slack profile: sessions born on the Slack channel resolve it instead of
// the orchestrator slot, so conversational replies can run a faster model than factory intake.
export const MODELS = {
  analyst: "deepseek/deepseek-v4-pro-0813",
  chat: "deepseek/deepseek-v4-pro-0813",
  classifier: "deepseek/deepseek-v4-pro-0813",
  implementer: "deepseek/deepseek-v4-pro-0813",
  orchestrator: "deepseek/deepseek-v4-pro-0813",
  researcher: "deepseek/deepseek-v4-pro-0813",
  reviewer: "deepseek/deepseek-v4-pro-0813",
} as const;

export type FactoryAgent = keyof typeof MODELS;

export const FACTORY_AGENTS = Object.keys(MODELS) as FactoryAgent[];

// A gateway model id is <provider>/<model>. The pattern is anchored and the length bounded
// because ids arrive as model input and end up stored where every future session reads them.
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export const isValidModelId = (id: string): boolean =>
  id.length <= 128 && MODEL_ID_PATTERN.test(id);

export type ModelOverrides = Partial<Record<FactoryAgent, string>>;

const overridesSchema = z.partialRecord(z.enum(FACTORY_AGENTS), z.string());

// Keyed on FACTORY_REPO like the factory brain: derived at module load, never from model input,
// hashed so the public object path carries no raw owner/repo.
const MODEL_OVERRIDES_KEY = `${MODEL_OVERRIDES_PREFIX}${createHash("sha256")
  .update(FACTORY_REPO)
  .digest("hex")}.json`;

// The strict read: Blob or parse failures propagate. set_factory_models mutates on top of this,
// because merging onto a silently-empty base would wipe overrides the call never named.
export const loadModelOverrides = async (): Promise<ModelOverrides> => {
  const doc = await readDocument(MODEL_OVERRIDES_KEY);
  if (!doc.found) {
    return {};
  }
  const parsed = overridesSchema.parse(JSON.parse(doc.content));
  return Object.fromEntries(
    Object.entries(parsed).filter(([, id]) => isValidModelId(id))
  );
};

// The session-start read: fail open to the compiled defaults (a Blob outage must never take the
// factory down) and memoize briefly so one session start resolves all six agents from a single
// consistent snapshot instead of six racing reads. The cache is per server instance, so a swap
// saved on one warm instance reaches the others within the TTL; the swap tools tell the caller
// to allow that window.
const OVERRIDES_CACHE_MS = 15_000;
let overridesCache: { at: number; promise: Promise<ModelOverrides> } | null =
  null;

export const readModelOverrides = (): Promise<ModelOverrides> => {
  if (overridesCache && Date.now() - overridesCache.at < OVERRIDES_CACHE_MS) {
    return overridesCache.promise;
  }
  const promise = loadModelOverrides().catch(() => ({}));
  overridesCache = { at: Date.now(), promise };
  return promise;
};

export const writeModelOverrides = async (
  overrides: ModelOverrides
): Promise<void> => {
  await writeDocument(MODEL_OVERRIDES_KEY, JSON.stringify(overrides, null, 2), {
    allowOverwrite: true,
    contentType: "application/json",
  });
  overridesCache = { at: Date.now(), promise: Promise.resolve(overrides) };
};

// What a session actually runs on: the live override when one is saved, the compiled default
// otherwise. Resolved once per session (session.started), so a swap applies to sessions that
// start after it, never mid-conversation.
export const resolveModel = async (agent: FactoryAgent): Promise<string> =>
  (await readModelOverrides())[agent] ?? MODELS[agent];

// The gateway catalog, through the same authenticated provider eve's model calls use.
// set_factory_models checks membership here before storing an id: a stored id the gateway
// doesn't know would fail every future session at start, with no session left to undo it.
export const listGatewayModels = async (): Promise<
  { id: string; name: string }[]
> => {
  const { models } = await gateway.getAvailableModels();
  return models.map(({ id, name }) => ({ id, name }));
};
