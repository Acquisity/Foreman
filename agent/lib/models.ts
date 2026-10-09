import { createAnthropic } from "@ai-sdk/anthropic";
import { gateway, type LanguageModel } from "ai";
import { z } from "zod";
import { MODEL_OVERRIDES_PREFIX, readDocument, writeDocument } from "./blob.js";

// One place to change every agent's model. Ids are Vercel AI Gateway strings (<provider>/<model>),
// so routing, credentials, and fallbacks stay on the gateway, except that modelFor sends every
// anthropic/ id to the CLI Proxy (ENG-15082).
// These are the compiled defaults; a live override saved by set_agent_models wins over them.
// Each agent.ts resolves its model through resolveModel(<agent>) at session start.
export const MODELS = {
  // Independent triage reviewer: a different vendor from the orchestrator on purpose.
  critic: "openai/gpt-5.6-sol",
  // Support widget egress reviewer: never investigates, never composes. On 111
  // real cases, two calls each (ENG-14669), gpt-5.6-sol with the same prompt let
  // through 9 bad sentences of 222 against deepseek-v4-pro's 11, at p50 2.7s
  // against 26 to 71s. Its 3 whole-answer blocks are retried with blocking off
  // (`guardedJudge` in widget-egress.ts).
  gate: "openai/gpt-5.6-sol",
  // Support widget help-center writer, grounded in a few public help articles:
  // the front door only with WIDGET_CHAT=legacy (ENG-14932).
  // Measured through the gateway 2026-09-28 on a full-size answer: flash-lite
  // p50 1.0s, flash p50 8.7s (4 to 16s), and 4 to 39s live on the preview.
  kb: "google/gemini-3.5-flash-lite",
  // Front-door chat (widget-chat.ts): one streamed reply with the whole product
  // guide in a cached system prefix, Google AI Studio first. Round 4 (ENG-14932,
  // 2026-10-08, 165 replies): p50 2.0s, p90 2.9s; 3.5-flash with low thinking
  // and Claude Haiku 5.5 both took p50 4.8s.
  kbChat: "google/gemini-3.6-flash",
  // The same answer when the customer's message carries screenshots. On the
  // #6627 preview's real conversations flash-lite answered a screenshot's
  // warning instead of the customer's request; flash followed the request.
  kbImages: "google/gemini-3.5-flash",
  // Picking help-center articles from the ~25k-token title index: no writing, so
  // flash-lite's weaknesses above do not apply. Measured through the gateway
  // 2026-09-28, 30 picks each on the full index: flash-lite p50 1.3s, max 1.6s,
  // with the same articles or better; flash p50 12.7s, max 27.8s.
  kbSelect: "google/gemini-3.5-flash-lite",
  orchestrator: "deepseek/deepseek-v4-pro-0813",
  // Cheap and vision-capable: this slot reads pixels, it does not reason.
  vision: "google/gemini-3.5-flash",
  // Support widget diagnosis: the investigator's write-up of what the evidence
  // shows, a question for the customer, and the reply. It runs once or twice an
  // investigation. Measured through the gateway 2026-09-23 on a full-size
  // write-up: sonnet-5 12 to 20s, haiku-4.5 10 to 16s, the orchestrator's
  // deepseek 39 to 41s, which with a deepseek call on every step ran 3 of 14
  // investigations past the widget deadline. The egress reviewer stays on `gate`.
  // ENG-15082 moved it from sonnet-5 to sonnet-5.5 when Claude calls moved to
  // the CLI Proxy (see modelFor); the timings above predate both changes.
  widget: "anthropic/claude-sonnet-5.5",
  // Support widget steps: Jev picks each read, so this only fills in its
  // arguments. haiku-4.5 took ~1s a call; gemini-3.5-flash took ~15s a call the
  // same afternoon. Moved to haiku-5.5 on Aaron's call with the CLI Proxy (ENG-15082).
  widgetSteps: "anthropic/claude-haiku-5.5",
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
// agent down) and memoize briefly so one session start resolves every agent slot from a single
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
// otherwise. The root, critic and vision resolve it at every step (step.started), so a swap
// reaches running sessions on their next step, after the cache window above.
export const resolveModel = async (agent: AgentModelSlot): Promise<string> =>
  (await readModelOverrides())[agent] ?? MODELS[agent];

const proxyConfig = () => {
  const baseURL = process.env.CLIPROXY_BASE_URL;
  const apiKey = process.env.CLIPROXY_API_KEY;
  if (!(baseURL && apiKey)) {
    throw new Error(
      "Claude models need the CLI Proxy: set CLIPROXY_BASE_URL and CLIPROXY_API_KEY"
    );
  }
  return { apiKey, baseURL };
};

export const proxyModelName = (id: string): string =>
  id.slice("anthropic/".length).replaceAll(".", "-");

// Claude ids use the CLI Proxy's dashed names and require its credentials.
// Every other id stays on the gateway; a failed proxy call has no gateway fallback.
export const modelFor = (id: string): Exclude<LanguageModel, string> =>
  id.startsWith("anthropic/")
    ? createAnthropic(proxyConfig())(proxyModelName(id))
    : gateway(id);

const proxyCatalogSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});
const TRAILING_SLASHES = /\/+$/u;

export const listProxyModels = async (): Promise<Set<string>> => {
  const { apiKey, baseURL } = proxyConfig();
  try {
    const response = await fetch(
      `${baseURL.replace(TRAILING_SLASHES, "")}/models`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      throw new Error("CLI Proxy catalog request failed.");
    }
    const { data } = proxyCatalogSchema.parse(await response.json());
    return new Set(data.map(({ id }) => id));
  } catch {
    // biome-ignore lint/style/useErrorCause: Provider errors can include credentials or response bodies.
    throw new Error("Could not read the CLI Proxy model catalog.");
  }
};

// Gateway routing for the root's DeepSeek calls. Every rejection found on ENG-13730 and
// ENG-13732 was a baseten call on a mixed-provider history ("reasoning_content in the thinking
// mode must be passed back", HTTP 400, no fallback), while fireworks accepts the same history,
// so baseten and the DeepSeek native endpoint are left off the list and the order runs the
// providers that tolerate the history, fastest first. Unlisted providers stay as fallback.
export const gatewayRouting = (modelId: string) =>
  modelId.startsWith("deepseek/")
    ? {
        providerOptions: {
          gateway: {
            order: [
              "fireworks",
              "wafer",
              "alibaba",
              "deepinfra",
              "novita",
              "modal",
            ],
          },
        },
      }
    : undefined;

// For calls that reformat or summarise text they were handed rather than reason
// about it. Measured on the support widget: on its defaults the fast model spends
// about 90% of its output on hidden reasoning (8 to 12s a call); with reasoning
// minimal the same call takes 1 to 3s with the same result. Providers that do not
// recognise the option ignore it, so a slot override stays safe.
export const fastCallOptions = (modelId: string) => ({
  providerOptions: {
    ...gatewayRouting(modelId)?.providerOptions,
    google: { thinkingConfig: { thinkingLevel: "minimal" } },
  },
});

// The gateway catalog, through the same authenticated provider eve's model calls use.
// set_agent_models checks non-Claude ids here; Claude ids use listProxyModels instead.
export const listGatewayModels = async (): Promise<
  { id: string; name: string }[]
> => {
  const { models } = await gateway.getAvailableModels();
  return models.map(({ id, name }) => ({ id, name }));
};
