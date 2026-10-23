import type { TestContext } from "node:test";
import type { executorClient } from "../executor/client.js";
import {
  loadReplayState,
  memoryBackend,
  replayStateKey,
  seedReplayStore,
  setReplayBackend,
} from "./backend.js";
import { triageReplayHook } from "./hook.js";
import {
  type AdmissionLedger,
  type LedgerEntries,
  replayAuth,
} from "./route.js";
import type { TriageCase, TriageLabel, TriageResult } from "./schema.js";
import { seedReplayState } from "./store.js";

/** Synthetic triage replay data for the scorer's tests; no real ticket content. */

export const SHA = "a".repeat(64);

export const makeCase = (
  id: string,
  overrides: Partial<TriageCase> = {}
): TriageCase => ({
  createdAt: "2026-09-01T10:00:00.000Z",
  flags: {
    alreadyFixedAtTriage: false,
    descriptionEditedAfterCreate: false,
    needsProductionData: false,
  },
  id,
  lane: "asks",
  provenance: "seeded",
  relatedSnapshot: [],
  repoCommitAtCreate: "0".repeat(40),
  stratum: "bug_master",
  ticket: {
    attachmentKinds: [],
    description: "The widget shows a blank panel after saving.",
    title: "Blank panel after save",
  },
  ...overrides,
});

export const makeLabel = (
  id: string,
  overrides: Partial<TriageLabel> = {}
): TriageLabel => ({
  classification: "Bug",
  duplicateOf: null,
  fixCommit: null,
  fixPr: null,
  id,
  insufficient: false,
  labelSource: ["synthetic"],
  master: "ENG-0",
  notes: "",
  outcomeAt: "2026-09-02T10:00:00.000Z",
  owner: "area owner",
  path: "fix",
  project: "Platform",
  rootCause: {
    files: ["src/panel.ts"],
    functions: ["renderPanel"],
    text: "The save handler cleared the cached layout before the panel rendered it again.",
  },
  verdict: "route",
  ...overrides,
});

export const makeResult = (
  caseId: string,
  overrides: Partial<TriageResult> = {}
): TriageResult => ({
  caseId,
  cohortSha256: SHA,
  critic: { blockingFindings: 0, failedCriteria: 0, verdict: "APPROVE" },
  document: {
    text: "Root cause: renderPanel.",
    updatedAt: "2026-09-01T10:05:00.000Z",
  },
  estimatedUsd: 4,
  evidenceMisses: [],
  final: {
    assignee: "area owner",
    classification: "Bug",
    duplicateOf: null,
    master: "ENG-0",
    outcome: "route",
    path: "fix",
    project: "Platform",
  },
  foremanCommit: "1".repeat(40),
  inputs: [],
  listMembershipUnknown: [],
  run: 1,
  runId: "run-1",
  startedAt: "2026-09-01T10:00:00.000Z",
  status: "completed",
  ...overrides,
});

export const RUN = "run-test-1";
export const KEY = "ENG-100#1";
export const CASE_CREATED = "2026-10-01T10:00:00.000Z";
export const TEST_SECRET = "t".repeat(40);
export const ARCHIVE_URL =
  "https://store.private.blob.vercel-storage.com/triage-replay/archives/a-x1.tar.gz";

export const triageCase: TriageCase = {
  createdAt: CASE_CREATED,
  flags: {
    alreadyFixedAtTriage: false,
    descriptionEditedAfterCreate: false,
    needsProductionData: false,
  },
  id: "ENG-100",
  lane: "triage",
  provenance: "seeded",
  relatedSnapshot: [
    {
      assignee: "Ada Lovelace",
      createdAt: "2026-09-20T00:00:00.000Z",
      description: "Inbox reconnect fails after the token expires",
      id: "ENG-90",
      labels: ["Bug"],
      parent: null,
      state: "Todo",
      title: "Inbox reconnect fails",
    },
    {
      assignee: "unknown",
      createdAt: "2026-09-25T00:00:00.000Z",
      description: "unknown",
      id: "ENG-95",
      labels: "unknown",
      parent: "unknown",
      state: "unknown",
      title: "Inbox reconnect loops",
    },
    {
      assignee: null,
      createdAt: "2026-10-05T00:00:00.000Z",
      description:
        "Filed after the case: inbox reconnect fixed by the token refresh",
      id: "ENG-130",
      labels: [],
      parent: null,
      state: "Done",
      title: "Inbox reconnect fix",
    },
  ],
  repoCommitAtCreate: "a".repeat(40),
  stratum: "bug_master",
  ticket: {
    attachmentKinds: [],
    description: "My inbox shows reconnect after every send.",
    title: "Inbox reconnect after send",
  },
};

const LISTED = "2026-01-01T00:00:00.000Z";

export const lists = {
  labels: [
    { createdAt: LISTED, id: "l-bug", name: "Bug" },
    { createdAt: LISTED, id: "l-cr", name: "Customer reported" },
  ],
  projects: [{ createdAt: LISTED, id: "p-ce", name: "Cold Email Core" }],
  states: [
    { createdAt: LISTED, id: "s-todo", name: "Todo" },
    { createdAt: LISTED, id: "s-dup", name: "Duplicate" },
  ],
  users: [
    {
      createdAt: LISTED,
      displayName: "ada",
      email: "ada@example.test",
      id: "u-ada",
      name: "Ada Lovelace",
    },
  ],
};

export const auth = replayAuth(RUN, KEY);
export const ctx = {
  abortSignal: new AbortController().signal,
  getToken: () => Promise.resolve({ token: "synthetic" }),
  session: { auth: { current: auth, initiator: auth } },
} as unknown as Parameters<typeof executorClient>[0];

/** A replay process with a memory store seeded for ENG-100, undone after the test. */
export async function replayProcess(t: TestContext) {
  const prior = { ...process.env };
  process.env.TRIAGE_REPLAY = "1";
  delete process.env.VERCEL_ENV;
  delete process.env.FOREMAN_MEMORY_DATABASE_URL;
  delete process.env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID;
  process.env.FOREMAN_DIAGNOSTICS_SECRET = TEST_SECRET;
  const backend = memoryBackend();
  setReplayBackend(backend);
  await seedReplayStore(
    replayStateKey(RUN, KEY),
    seedReplayState(triageCase, lists, ARCHIVE_URL),
    backend
  );
  t.after(() => {
    process.env = prior;
  });
  return backend;
}

export const state = async () => {
  const loaded = await loadReplayState(replayStateKey(RUN, KEY));
  if (!loaded) {
    throw new Error("No seeded replay store.");
  }
  return loaded;
};

type ReplayHookEvent = keyof NonNullable<typeof triageReplayHook.events>;

export function replayHandler(name: ReplayHookEvent) {
  const handler = triageReplayHook.events?.[name];
  if (!handler) {
    throw new Error(`The replay hook has no ${name} handler.`);
  }
  return handler as (event: unknown, ctx: unknown) => Promise<void>;
}

export async function outputOf<T>(
  result: T | AsyncIterable<T> | Promise<T | AsyncIterable<T>>
): Promise<T> {
  const value = await result;
  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  ) {
    throw new Error("A replay tool returned a stream, not one result.");
  }
  return value as T;
}

export const sharedLedger = () => {
  let stored: (LedgerEntries & { etag: string }) | null = null;
  let version = 0;
  return (): AdmissionLedger => ({
    read: () =>
      Promise.resolve(
        stored
          ? {
              admitted: [...stored.admitted],
              chargedUsd: stored.chargedUsd,
              etag: stored.etag,
              reserved: { ...stored.reserved },
            }
          : { admitted: [], chargedUsd: 0, etag: null, reserved: {} }
      ),
    write: (_run, entries, etag) => {
      if ((stored?.etag ?? null) !== etag) {
        return Promise.resolve("conflict" as const);
      }
      version += 1;
      stored = { ...entries, etag: `v${version}` };
      return Promise.resolve("written" as const);
    },
  });
};
