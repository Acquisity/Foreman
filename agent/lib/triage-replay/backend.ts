import { createHmac, randomUUID } from "node:crypto";
import {
  listPrivateDocuments,
  readPrivateDocument,
  TRIAGE_REPLAY_PREFIX,
  writePrivateDocument,
} from "../blob.js";
import type { ReplayInput, ReplayState } from "./store.js";

/**
 * Where a replay session's simulated store lives between steps. Root and
 * critic run as separate eve sessions and may run in separate invocations,
 * so the store is keyed by run and case rather than held in one process.
 * Every write is conditional on the version it read, so two processes can't
 * overwrite each other's changes, and run inputs are appended one key each.
 * Everything is private, under keys derived from the server's secret.
 */
export interface ReplayBackend {
  appendInputs: (key: string, inputs: readonly ReplayInput[]) => Promise<void>;
  listInputs: (key: string) => Promise<ReplayInput[]>;
  read: (key: string) => Promise<{ etag: string; state: ReplayState } | null>;
  write: (
    key: string,
    state: ReplayState,
    etag: string | null
  ) => Promise<"conflict" | "written">;
}

export class ReplayStateConflictError extends Error {
  constructor(key: string) {
    super(`Triage replay state ${key} kept changing; refusing the write.`);
    this.name = "ReplayStateConflictError";
  }
}

const MAX_ATTEMPTS = 8;

export const replayKeyDigest = (
  parts: readonly string[],
  env: NodeJS.ProcessEnv = process.env
) => {
  const secret = env.FOREMAN_DIAGNOSTICS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Triage replay storage needs FOREMAN_DIAGNOSTICS_SECRET.");
  }
  return createHmac("sha256", secret).update(parts.join("\n")).digest("hex");
};

export const replayStateKey = (runId: string, caseId: string) =>
  `${TRIAGE_REPLAY_PREFIX}${replayKeyDigest([runId, caseId])}/state.json`;

const STATE_FILE = /state\.json$/u;
const inputsPrefix = (key: string) => key.replace(STATE_FILE, "inputs/");

const withoutInputs = (state: ReplayState): ReplayState => ({
  ...state,
  inputs: [],
});

/** One process holds every store; for tests and a single local `eve dev`. */
export function memoryBackend(): ReplayBackend {
  const states = new Map<string, { etag: string; raw: string }>();
  const inputs = new Map<string, string[]>();
  let version = 0;
  return {
    appendInputs: (key, added) => {
      inputs.set(key, [
        ...(inputs.get(key) ?? []),
        ...added.map((input) => JSON.stringify(input)),
      ]);
      return Promise.resolve();
    },
    listInputs: (key) =>
      Promise.resolve(
        (inputs.get(key) ?? []).map((raw) => JSON.parse(raw) as ReplayInput)
      ),
    read: (key) => {
      const stored = states.get(key);
      return Promise.resolve(
        stored
          ? { etag: stored.etag, state: JSON.parse(stored.raw) as ReplayState }
          : null
      );
    },
    write: (key, state, etag) => {
      if ((states.get(key)?.etag ?? null) !== etag) {
        return Promise.resolve("conflict");
      }
      version += 1;
      states.set(key, {
        etag: `v${version}`,
        raw: JSON.stringify(withoutInputs(state)),
      });
      return Promise.resolve("written");
    },
  };
}

/** Blob-backed store for a deployed replay, where steps may land on different invocations. */
export const blobBackend: ReplayBackend = {
  async appendInputs(key, added) {
    const stamp = String(Date.now()).padStart(15, "0");
    const written = await Promise.all(
      added.map((input, index) =>
        writePrivateDocument(
          `${inputsPrefix(key)}${stamp}-${String(index).padStart(4, "0")}-${randomUUID()}.json`,
          JSON.stringify(input),
          { contentType: "application/json", ifMatch: null }
        )
      )
    );
    if (written.includes("conflict")) {
      throw new ReplayStateConflictError(key);
    }
  },
  async listInputs(key) {
    const keys = await listPrivateDocuments(inputsPrefix(key));
    const documents = await Promise.all(
      keys
        .sort((a, b) => a.localeCompare(b))
        .map((inputKey) => readPrivateDocument(inputKey))
    );
    return documents.flatMap((document) =>
      document.found ? [JSON.parse(document.content) as ReplayInput] : []
    );
  },
  async read(key) {
    const result = await readPrivateDocument(key);
    return result.found
      ? { etag: result.etag, state: JSON.parse(result.content) as ReplayState }
      : null;
  },
  write: (key, state, etag) =>
    writePrivateDocument(key, JSON.stringify(withoutInputs(state)), {
      contentType: "application/json",
      ifMatch: etag,
    }),
};

let active: ReplayBackend =
  process.env.TRIAGE_REPLAY_STATE === "memory" ? memoryBackend() : blobBackend;

/** Swaps the backend; tests use a memory backend. */
export function setReplayBackend(backend: ReplayBackend) {
  active = backend;
}

export const replayBackend = () => active;

export async function seedReplayStore(
  key: string,
  state: ReplayState,
  backend: ReplayBackend = active
) {
  if ((await backend.write(key, state, null)) === "conflict") {
    throw new ReplayStateConflictError(key);
  }
  await backend.appendInputs(key, state.inputs);
}

export async function loadReplayState(
  key: string,
  backend: ReplayBackend = active
): Promise<ReplayState | null> {
  const stored = await backend.read(key);
  return stored
    ? { ...stored.state, inputs: await backend.listInputs(key) }
    : null;
}

export async function updateReplayState<T>(
  key: string,
  fn: (state: ReplayState) => T,
  backend: ReplayBackend = active,
  attempt = 0
): Promise<T> {
  if (attempt >= MAX_ATTEMPTS) {
    throw new ReplayStateConflictError(key);
  }
  const stored = await backend.read(key);
  if (!stored) {
    throw new Error(`No triage replay store at ${key}.`);
  }
  const state = { ...stored.state, inputs: [] };
  const result = fn(state);
  if ((await backend.write(key, state, stored.etag)) === "conflict") {
    return updateReplayState(key, fn, backend, attempt + 1);
  }
  await backend.appendInputs(key, state.inputs);
  return result;
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Applies `fn` to a session's store with a conditional write, retrying on a
 * lost race. Calls for one case also run one at a time in this process, so
 * the root and its critic rarely race here.
 */
export function withReplayState<T>(
  runId: string,
  caseId: string,
  fn: (state: ReplayState) => T
): Promise<T> {
  const key = replayStateKey(runId, caseId);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => updateReplayState(key, fn));
  queues.set(key, next);
  return next;
}
