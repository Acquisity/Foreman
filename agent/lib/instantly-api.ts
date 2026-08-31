import { z } from "zod";

const INSTANTLY_API_URL = "https://api.instantly.ai/api/v2";
const IBG_ADMIN_WORKSPACE_ID = "24f5c554-bf6c-4f51-a909-d25d9617cff9";
const PAGE_LIMIT = 100;
const MAX_GROUP_PAGES = 100;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

const workspaceGroupMemberSchema = z.object({
  admin_workspace_id: z.string().uuid(),
  admin_workspace_name: z.string().nullable(),
  id: z.string().uuid(),
  status: z.enum(["pending", "accepted", "rejected"]),
  sub_workspace_id: z.string().uuid(),
  sub_workspace_name: z.string().nullable(),
});

const pageSchema = z.object({
  items: z.array(z.unknown()),
  next_starting_after: z.string().nullish(),
});

export type InstantlyResource = "accounts" | "campaigns" | "emails";

export interface InstantlyWorkspace {
  id: string;
  name: string | null;
}

export type InstantlyAdminWorkspace = InstantlyWorkspace;

interface InstantlyApiOptions {
  fetch?: Fetcher;
  signal?: AbortSignal;
  sleep?: Sleeper;
}

export interface InstantlyResourceQuery {
  campaignId?: string;
  emailAccount?: string;
  emailType?: "received" | "sent" | "manual";
  latestOfThread?: boolean;
  lead?: string;
  limit?: number;
  maxTimestampCreated?: string;
  minTimestampCreated?: string;
  providerCode?: number;
  search?: string;
  startingAfter?: string;
  status?: number;
}

export interface InstantlyWorkspaceSelector {
  id?: string;
  name?: string;
}

export interface InstantlyWorkspaceGroup {
  adminWorkspace: InstantlyAdminWorkspace;
  excludedMemberships: { pending: number; rejected: number };
  subworkspaces: InstantlyWorkspace[];
}

export interface InstantlyResourcePage {
  items: unknown[];
  nextStartingAfter: string | null;
  resource: InstantlyResource;
  workspace: InstantlyWorkspace;
}

type ErrorKind =
  | "authorization"
  | "inaccessible"
  | "invalid-input"
  | "invalid-response"
  | "not-found"
  | "rate-limited"
  | "too-much-data";

/** A safe Instantly error. Provider response bodies and credentials are omitted. */
export class InstantlyApiError extends Error {
  readonly kind: ErrorKind;
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      kind: ErrorKind;
      retryAfterSeconds?: number | null;
      status?: number | null;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "InstantlyApiError";
    this.kind = options.kind;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.status = options.status ?? null;
  }
}

const tooMuchData = (): InstantlyApiError =>
  new InstantlyApiError(
    "Instantly returned too much data. Narrow the lookup before concluding.",
    { kind: "too-much-data" }
  );

const defaultSleep: Sleeper = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Resolves when the signal aborts, bounding a disposal that never settles. */
const abortSettled = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const discardResponseBody = async (
  response: Response,
  signal?: AbortSignal
): Promise<void> => {
  const discarded = response.body?.cancel().catch(() => undefined);
  await (signal === undefined
    ? discarded
    : Promise.race([discarded, abortSettled(signal)]));
};

const readBeforeAbort = <T>(
  reader: ReadableStreamDefaultReader<T>,
  aborted?: Promise<null>
): Promise<ReadableStreamReadResult<T> | null> =>
  aborted === undefined
    ? reader.read()
    : Promise.race([reader.read(), aborted]);

const readBoundedText = async (
  response: Response,
  signal?: AbortSignal
): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await discardResponseBody(response, signal);
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw tooMuchData();
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const aborted = signal && abortSettled(signal).then(() => null);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: stream completion terminates the loop.
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: chunks must be read sequentially to enforce the cap.
    const result = await readBeforeAbort(reader, aborted);
    if (result === null) {
      reader.cancel().catch(() => undefined);
      throw signal?.reason;
    }
    const { done, value } = result;
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      const cancelled = reader.cancel().catch(() => undefined);
      await (signal === undefined
        ? cancelled
        : Promise.race([cancelled, abortSettled(signal)]));
      if (signal?.aborted) {
        throw signal.reason;
      }
      throw tooMuchData();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
};

const retryAfterSeconds = (response: Response): number | null => {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
};

const isAbortError = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true ||
  (error instanceof Error && error.name === "AbortError");

const statusError = (response: Response): InstantlyApiError => {
  const { status } = response;
  if (status === 401) {
    return new InstantlyApiError(
      "Instantly rejected the admin credential. It may be revoked or invalid.",
      { kind: "authorization", status }
    );
  }
  if (status === 403) {
    return new InstantlyApiError(
      "Instantly denied this read. Check the API key's read scopes and workspace access.",
      { kind: "authorization", status }
    );
  }
  if (status === 404) {
    return new InstantlyApiError(
      "Instantly could not find the selected workspace or resource.",
      { kind: "not-found", status }
    );
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return new InstantlyApiError(
      retryAfter === null
        ? "Instantly rate-limited this read. Retry later."
        : `Instantly rate-limited this read. Retry after ${retryAfter} seconds.`,
      {
        kind: "rate-limited",
        retryAfterSeconds: retryAfter,
        status,
      }
    );
  }
  return new InstantlyApiError(`Instantly read failed with HTTP ${status}.`, {
    kind: "inaccessible",
    status,
  });
};

const parsePage = async (
  response: Response,
  signal?: AbortSignal
): Promise<z.infer<typeof pageSchema>> => {
  if (!response.ok) {
    const error = statusError(response);
    await discardResponseBody(response, signal);
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw error;
  }
  const text = await readBoundedText(response, signal);
  try {
    return pageSchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof InstantlyApiError) {
      throw error;
    }
    throw new InstantlyApiError("Instantly returned an unreadable response.", {
      cause: error,
      kind: "invalid-response",
    });
  }
};

interface RequestDeadline {
  /** Disarms the deadline once the request is finished with. */
  readonly clear: () => void;
  /** The timeout error when this request's own deadline aborted it, else null. */
  readonly expiry: (cause: unknown) => InstantlyApiError | null;
  readonly signal: AbortSignal;
}

/**
 * Arms one request's deadline and composes it with the caller's signal.
 * Expiry is classified from the composed signal's first abort reason, which
 * never changes once set, so a caller that aborts after the deadline fired
 * cannot turn a timeout into a cancellation, and an unrelated error merely
 * named TimeoutError never becomes the deadline message. The deadline is its
 * own controller so that reason is an identity the classification can compare.
 */
const startDeadline = (callerSignal?: AbortSignal): RequestDeadline => {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException("The operation timed out.", "TimeoutError")
      ),
    REQUEST_TIMEOUT_MS
  );
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline.signal])
    : deadline.signal;
  return {
    clear: () => clearTimeout(timer),
    expiry: (cause) =>
      deadline.signal.aborted && signal.reason === deadline.signal.reason
        ? new InstantlyApiError(
            `Instantly did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
            { cause, kind: "inaccessible" }
          )
        : null,
    signal,
  };
};

/** Runs one deadline-covered step, reporting an expiry as a timeout. */
const withDeadline = async <T>(
  deadline: RequestDeadline,
  run: () => Promise<T>
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw deadline.expiry(error) ?? error;
  }
};

/**
 * Disposes a retryable response inside the attempt's own deadline, so a body
 * whose cancellation never settles cannot outlive the request's own time. The
 * deadline is disarmed only once the attempt is finished with the response.
 *
 * Because that bound is an abort, disposal can end without having finished.
 * The composed signal's first abort reason, which never changes once set,
 * decides what the attempt does next: this request's own expiry is reported as
 * a timeout and never retried, a caller's cancellation propagates unchanged,
 * and a disposal that genuinely finished leaves the retry untouched.
 */
const disposeResponse = async (
  response: Response,
  deadline: RequestDeadline
): Promise<void> => {
  try {
    await discardResponseBody(response, deadline.signal);
  } finally {
    deadline.clear();
  }
  if (deadline.signal.aborted) {
    const reason: unknown = deadline.signal.reason;
    throw deadline.expiry(reason) ?? reason;
  }
};

const requestHeaders = (
  token: string,
  workspaceId: string | undefined
): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  ...(workspaceId === undefined ? {} : { "x-as-workspace": workspaceId }),
});

/** The backoff for a retryable status, or null when it exceeds the wait cap. */
const retryDelayMs = (response: Response, attempt: number): number | null => {
  const retryAfter = retryAfterSeconds(response);
  const delay = retryAfter === null ? 500 * 2 ** attempt : retryAfter * 1000;
  return delay > MAX_RETRY_DELAY_MS ? null : delay;
};

const callPage = async (
  token: string,
  path: string,
  workspaceId: string | undefined,
  options: InstantlyApiOptions
): Promise<z.infer<typeof pageSchema>> => {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;

  while (attempt < 3) {
    const deadline = startDeadline(options.signal);
    let response: Response;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: retries are intentionally sequential.
      response = await fetchImpl(`${INSTANTLY_API_URL}${path}`, {
        headers: requestHeaders(token, workspaceId),
        method: "GET",
        signal: deadline.signal,
      });
    } catch (error) {
      deadline.clear();
      // A request that ran out of its own time is reported, never retried.
      const expired = deadline.expiry(error);
      if (expired !== null) {
        throw expired;
      }
      if (isAbortError(error, options.signal)) {
        throw error;
      }
      if (attempt < 2) {
        const delay = 500 * 2 ** attempt;
        attempt += 1;
        await sleep(delay, options.signal);
        continue;
      }
      throw new InstantlyApiError("Instantly could not be reached.", {
        cause: error,
        kind: "inaccessible",
      });
    }

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 2) {
      try {
        // The deadline still covers the response body this request is reading.
        return await withDeadline(deadline, () =>
          parsePage(response, deadline.signal)
        );
      } finally {
        deadline.clear();
      }
    }

    const delay = retryDelayMs(response, attempt);
    await disposeResponse(response, deadline);
    if (delay === null) {
      throw statusError(response);
    }
    attempt += 1;
    await sleep(delay, options.signal);
  }

  throw new InstantlyApiError("Instantly could not be reached.", {
    kind: "inaccessible",
  });
};

const normalizeName = (name: string): string =>
  name.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");

const SAFE_ITEM_FIELDS: Record<InstantlyResource, readonly string[]> = {
  accounts: [
    "autofix_failed",
    "daily_limit",
    "email",
    "enable_slow_ramp",
    "first_name",
    "inbox_placement_test_limit",
    "is_managed_account",
    "last_name",
    "provider_code",
    "sending_gap",
    "setup_pending",
    "stat_warmup_score",
    "status",
    "timestamp_created",
    "timestamp_last_used",
    "timestamp_updated",
    "timestamp_warmup_start",
    "tracking_domain_name",
    "tracking_domain_status",
    "warmup_status",
  ],
  campaigns: [
    "id",
    "is_evergreen",
    "name",
    "pl_value",
    "status",
    "timestamp_created",
    "timestamp_updated",
  ],
  emails: [
    "campaign_id",
    "content_preview",
    "email_type",
    "id",
    "is_unread",
    "lead_id",
    "marked_as_done",
    "message_id",
    "subject",
    "thread_id",
    "timestamp_created",
    "timestamp_email",
    "timestamp_updated",
  ],
};

const enforceOutputBudget = <T>(value: T): T => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESPONSE_BYTES) {
    throw tooMuchData();
  }
  return value;
};

/** Lists accepted subworkspaces from a complete, safety-bounded group result. */
export async function listInstantlySubworkspaces(
  token: string,
  options: InstantlyApiOptions = {}
): Promise<InstantlyWorkspaceGroup> {
  const members: z.infer<typeof workspaceGroupMemberSchema>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_GROUP_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor !== null) {
      query.set("starting_after", cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Workspace Group cursors are sequential.
    const page = await callPage(
      token,
      `/workspace-group-members?${query.toString()}`,
      undefined,
      options
    );
    try {
      members.push(
        ...page.items.map((item) => workspaceGroupMemberSchema.parse(item))
      );
    } catch (error) {
      throw new InstantlyApiError(
        "Instantly returned invalid Workspace Group membership data.",
        { cause: error, kind: "invalid-response" }
      );
    }

    cursor = page.next_starting_after ?? null;
    if (cursor === null) {
      break;
    }
    if (seenCursors.has(cursor)) {
      throw new InstantlyApiError(
        "Instantly repeated a Workspace Group pagination cursor.",
        { kind: "invalid-response" }
      );
    }
    seenCursors.add(cursor);
    if (pageNumber === MAX_GROUP_PAGES - 1) {
      throw new InstantlyApiError(
        "Instantly returned too many Workspace Group pages.",
        { kind: "too-much-data" }
      );
    }
  }

  const [first] = members;
  if (first === undefined) {
    throw new InstantlyApiError(
      "Instantly returned no Workspace Group memberships for the admin workspace.",
      { kind: "not-found" }
    );
  }
  if (first.admin_workspace_id !== IBG_ADMIN_WORKSPACE_ID) {
    throw new InstantlyApiError(
      "Instantly credential is not bound to the configured IBG admin workspace.",
      { kind: "authorization" }
    );
  }
  if (
    members.some(
      (member) => member.admin_workspace_id !== first.admin_workspace_id
    )
  ) {
    throw new InstantlyApiError(
      "Instantly returned memberships from more than one admin workspace.",
      { kind: "invalid-response" }
    );
  }

  return enforceOutputBudget({
    adminWorkspace: {
      id: first.admin_workspace_id,
      name: first.admin_workspace_name,
    },
    excludedMemberships: {
      pending: members.filter((member) => member.status === "pending").length,
      rejected: members.filter((member) => member.status === "rejected").length,
    },
    subworkspaces: members
      .filter((member) => member.status === "accepted")
      .map((member) => ({
        id: member.sub_workspace_id,
        name: member.sub_workspace_name,
      })),
  });
}

const resolveWorkspace = async (
  token: string,
  selector: InstantlyWorkspaceSelector,
  options: InstantlyApiOptions
): Promise<InstantlyWorkspace> => {
  const group = await listInstantlySubworkspaces(token, options);
  const matches = group.subworkspaces.filter((workspace) =>
    selector.id === undefined
      ? workspace.name !== null &&
        normalizeName(workspace.name) === normalizeName(selector.name ?? "")
      : workspace.id === selector.id
  );
  if (matches.length === 1) {
    return matches[0] as InstantlyWorkspace;
  }
  if (matches.length > 1) {
    throw new InstantlyApiError(
      "More than one accepted Instantly subworkspace has that name. Select it by workspace ID.",
      { kind: "not-found" }
    );
  }
  throw new InstantlyApiError(
    "No accepted Instantly subworkspace matched that selection.",
    { kind: "not-found" }
  );
};

const sanitizeItems = (
  resource: InstantlyResource,
  items: unknown[]
): unknown[] =>
  items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new InstantlyApiError(
        `Instantly returned invalid ${resource} data.`,
        { kind: "invalid-response" }
      );
    }
    const record = item as Record<string, unknown>;
    const safe: Record<string, boolean | null | number | string> = {};
    for (const field of SAFE_ITEM_FIELDS[resource]) {
      const value = record[field];
      if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
      ) {
        safe[field] = value;
      }
    }
    return safe;
  });

const appendEmailQuery = (
  params: URLSearchParams,
  query: InstantlyResourceQuery
): void => {
  params.set("preview_only", "true");
  const values = {
    campaign_id: query.campaignId,
    eaccount: query.emailAccount,
    email_type: query.emailType,
    latest_of_thread:
      query.latestOfThread === undefined
        ? undefined
        : String(query.latestOfThread),
    lead: query.lead,
    max_timestamp_created: query.maxTimestampCreated,
    min_timestamp_created: query.minTimestampCreated,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      params.set(name, value);
    }
  }
};

const resourcePath = (
  resource: InstantlyResource,
  query: InstantlyResourceQuery
): string => {
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw new InstantlyApiError(
      "Instantly resource limit must be an integer from 1 to 100.",
      { kind: "invalid-input" }
    );
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.startingAfter !== undefined) {
    params.set("starting_after", query.startingAfter);
  }
  if (query.search !== undefined) {
    params.set("search", query.search);
  }
  if (query.status !== undefined) {
    params.set("status", String(query.status));
  }
  if (resource === "accounts" && query.providerCode !== undefined) {
    params.set("provider_code", String(query.providerCode));
  }
  if (resource === "emails") {
    appendEmailQuery(params, query);
  }
  return `/${resource}?${params.toString()}`;
};

/** Reads one bounded resource page as an accepted subworkspace. */
export async function readInstantlySubworkspace(
  token: string,
  selector: InstantlyWorkspaceSelector,
  resource: InstantlyResource,
  query: InstantlyResourceQuery = {},
  options: InstantlyApiOptions = {}
): Promise<InstantlyResourcePage> {
  const path = resourcePath(resource, query);
  const workspace = await resolveWorkspace(token, selector, options);
  const page = await callPage(token, path, workspace.id, options);
  return enforceOutputBudget({
    items: sanitizeItems(resource, page.items),
    nextStartingAfter: page.next_starting_after ?? null,
    resource,
    workspace,
  });
}
