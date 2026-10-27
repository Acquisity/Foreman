import type { TestContext } from "node:test";
import { evePackageUrl } from "../eve-dynamic-tools.js";
import type { executorClient } from "../executor/client.js";
import {
  memoryBackend,
  readReplayState,
  seedReplayStore,
  setReplayBackend,
} from "./backend.js";
import { triageReplayHook } from "./hook.js";
import { replayAuth } from "./route.js";
import type { TriageCase, TriageLabel, TriageResult } from "./schema.js";
import { seedReplayState } from "./store.js";

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
  critic: { blockingFindings: 0, failedCriteria: 0, verdict: "APPROVE" },
  diagnosis: "renderPanel in apps/web/src/panel.ts clears the layout.",
  document: {
    text: "## Root cause\nrenderPanel in apps/web/src/panel.ts clears the layout.",
    updatedAt: "2026-09-01T10:05:00.000Z",
  },
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

export async function replayProcess(t: TestContext) {
  const prior = { ...process.env };
  process.env.TRIAGE_REPLAY = "1";
  delete process.env.VERCEL_ENV;
  delete process.env.FOREMAN_MEMORY_DATABASE_URL;
  delete process.env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID;
  process.env.FOREMAN_DIAGNOSTICS_SECRET = TEST_SECRET;
  setReplayBackend(memoryBackend());
  await seedReplayStore(
    seedReplayState(triageCase, {
      archiveUrl: ARCHIVE_URL,
      caseKey: KEY,
      lists,
      stamp: { foremanCommit: "unknown", startedAt: CASE_CREATED },
    }),
    RUN
  );
  t.after(() => {
    process.env = prior;
  });
}

export const state = () => readReplayState(RUN, KEY);

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

interface EveContextModule {
  ContextContainer: new () => unknown;
  contextStorage: { run: <T>(store: unknown, run: () => T) => T };
}

const { ContextContainer, contextStorage } = (await import(
  new URL("./dist/src/context/container.js", evePackageUrl()).href
)) as EveContextModule;

const enterContext = contextStorage.run.bind(contextStorage);

export const inSession = <T>(body: () => T): T =>
  enterContext(new ContextContainer(), body);
