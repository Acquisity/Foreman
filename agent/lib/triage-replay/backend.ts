import { get, put } from "@vercel/blob";
import { TRIAGE_REPLAY_PREFIX } from "../blob.js";
import type { ReplayState } from "./store.js";

const BLOB_TIMEOUT_MS = 20_000;

export interface ReplayBackend {
  read: (key: string) => Promise<ReplayState | null>;
  write: (key: string, state: ReplayState) => Promise<void>;
}

export const blobBackend: ReplayBackend = {
  async read(key) {
    const result = await get(key, {
      abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
      access: "private",
      useCache: false,
    });
    return result?.stream
      ? (JSON.parse(await new Response(result.stream).text()) as ReplayState)
      : null;
  },
  async write(key, state) {
    await put(key, JSON.stringify(state), {
      abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  },
};

export function memoryBackend(): ReplayBackend {
  const states = new Map<string, string>();
  return {
    read: (key) => {
      const raw = states.get(key);
      return Promise.resolve(raw ? (JSON.parse(raw) as ReplayState) : null);
    },
    write: (key, state) => {
      states.set(key, JSON.stringify(state));
      return Promise.resolve();
    },
  };
}

let active: ReplayBackend =
  process.env.TRIAGE_REPLAY_STATE === "memory" ? memoryBackend() : blobBackend;

export function setReplayBackend(backend: ReplayBackend) {
  active = backend;
}

export const replayStateKey = (runId: string, caseKey: string) =>
  `${TRIAGE_REPLAY_PREFIX}${runId}/${caseKey}.json`;

export const loadReplayState = (runId: string, caseKey: string) =>
  active.read(replayStateKey(runId, caseKey));

export async function readReplayState(runId: string, caseKey: string) {
  const state = await loadReplayState(runId, caseKey);
  if (!state) {
    throw new Error(`No triage replay store for ${runId} ${caseKey}.`);
  }
  return state;
}

export const seedReplayStore = (state: ReplayState, runId: string) =>
  active.write(replayStateKey(runId, state.caseKey), state);

const queues = new Map<string, Promise<unknown>>();

export function withReplayState<T>(
  runId: string,
  caseKey: string,
  fn: (state: ReplayState) => T
): Promise<T> {
  const key = replayStateKey(runId, caseKey);
  const next = (queues.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const state = await readReplayState(runId, caseKey);
      const result = fn(state);
      await active.write(key, state);
      return result;
    });
  queues.set(key, next);
  return next;
}
