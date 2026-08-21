import { gateway } from "ai";
import { z } from "zod";
import { MODEL_OVERRIDES_PREFIX, readDocument, writeDocument } from "./blob.js";

// One place to change every agent's model. Ids are Vercel AI Gateway strings (<provider>/<model>),
// so routing, credentials, and fallbacks stay on the gateway and no provider SDK is wired in.
// These are the compiled defaults; a live override saved by set_agent_models wins over them.
// Each agent.ts resolves its model through resolveModel(<agent>) at session start.
export const MODELS = {
  analyst: "deepseek/deepseek-v4-pro-0813",
  classifier: "deepseek/deepseek-v4-pro-0813",
  implementer: "deepseek/deepseek-v4-pro-0813",
  investigator: "deepseek/deepseek-v4-pro-0813",
  orchestrator: "deepseek/deepseek-v4-pro-0813",
  researcher: "deepseek/deepseek-v4-pro-0813",
  reviewer: "anthropic/claude-opus-4.8",
  // Cheap and vision-capable: this slot reads pixels, it does not reason.
  vision: "openai/gpt-5.6-luna",
} as const;

export type AgentModelSlot = keyof typeof MODELS;

export const AGENT_MODEL_SLOTS = Object.keys(MODELS) as AgentModelSlot[];

// A gateway model id is <provider>/<model>. The pattern is anchored and the length bounded
// because ids arrive as model input and end up stored where every future session reads them.
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export const isValidModelId = (id: string): boolean =>
  id.length <= 128 && MODEL_ID_PATTERN.test(id);

export type ModelOverrides = Partial<Record<AgentModelSlot, string>>;

// Global to Foreman rather than repository-scoped.
const MODEL_OVERRIDES_KEY = `${MODEL_OVERRIDES_PREFIX}foreman.json`;

// Parse a stored overrides document by reading only the known slots, dropping
// unknown keys (e.g. a persisted `chat` override), non-string values, and ids
// that fail validation, so a stale key can never break set_agent_models.
export const parseModelOverrides = (content: string): ModelOverrides => {
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(content));
  const overrides: ModelOverrides = {};
  for (const slot of AGENT_MODEL_SLOTS) {
    const id = raw[slot];
    if (typeof id === "string" && isValidModelId(id)) {
      overrides[slot] = id;
    }
  }
  return overrides;
};

// The strict read: a Blob failure or unparseable JSON propagates, because
// set_agent_models mutates on top of this and merging onto a silently-empty
// base would wipe overrides the call never named.
export const loadModelOverrides = async (): Promise<ModelOverrides> => {
  const doc = await readDocument(MODEL_OVERRIDES_KEY);
  if (!doc.found) {
    return {};
  }
  return parseModelOverrides(doc.content);
};

// The session-start read: fail open to the compiled defaults (a Blob outage must never take the
// factory down) and memoize briefly so one session start resolves every agent slot from a single
// consistent snapshot instead of racing reads. The cache is per server instance, so a swap
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
export const resolveModel = async (agent: AgentModelSlot): Promise<string> =>
  (await readModelOverrides())[agent] ?? MODELS[agent];

// The gateway catalog, through the same authenticated provider eve's model calls use.
// set_agent_models checks membership here before storing an id: a stored id the gateway
// doesn't know would fail every future session at start, with no session left to undo it.
export const listGatewayModels = async (): Promise<
  { id: string; name: string }[]
> => {
  const { models } = await gateway.getAvailableModels();
  return models.map(({ id, name }) => ({ id, name }));
};
