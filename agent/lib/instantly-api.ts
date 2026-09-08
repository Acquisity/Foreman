import { isConnectionAuthorizationFailedError } from "eve/connections";
import { z } from "zod";
import {
  type OperationRequest,
  type ProviderClient,
  type ProviderResult,
  requiredClient,
} from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";

const IBG_ADMIN_WORKSPACE_ID = "24f5c554-bf6c-4f51-a909-d25d9617cff9";
const PAGE_LIMIT = 100;
const MAX_GROUP_PAGES = 100;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

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
  client?: ProviderClient;
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

const retryAfterSeconds = (response: ProviderResult): number | null => {
  const value = response.retryAfter;
  if (value === undefined) {
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

const statusError = (response: ProviderResult): InstantlyApiError => {
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

const parsePage = (response: ProviderResult): z.infer<typeof pageSchema> => {
  if (response.status < 200 || response.status >= 300) {
    throw statusError(response);
  }
  if (
    Buffer.byteLength(JSON.stringify(response.data), "utf8") >
    MAX_RESPONSE_BYTES
  ) {
    throw tooMuchData();
  }
  try {
    return pageSchema.parse(response.data);
  } catch (error) {
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

/** The backoff for a retryable status, or null when it exceeds the wait cap. */
const retryDelayMs = (
  response: ProviderResult,
  attempt: number
): number | null => {
  const retryAfter = retryAfterSeconds(response);
  // Older Executor versions discard failure headers. Never guess a short wait after 429.
  if (response.status === 429 && retryAfter === null) {
    return null;
  }
  const delay = retryAfter === null ? 500 * 2 ** attempt : retryAfter * 1000;
  return delay > MAX_RETRY_DELAY_MS ? null : delay;
};

function classifyTransportFailure(
  error: unknown,
  deadline: RequestDeadline,
  signal?: AbortSignal
): void {
  if (isConnectionAuthorizationFailedError(error) && !error.retryable) {
    throw error;
  }
  // A request that ran out of its own time is reported, never retried.
  const expired = deadline.expiry(error);
  if (expired !== null) {
    throw expired;
  }
  if (isAbortError(error, signal)) {
    throw error;
  }
  if (error instanceof ExecutorError && error.code === "response_too_large") {
    throw tooMuchData();
  }
}

const callPage = async (
  request: OperationRequest,
  options: InstantlyApiOptions
): Promise<z.infer<typeof pageSchema>> => {
  const client = requiredClient(options.client);
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;

  while (attempt < 3) {
    const deadline = startDeadline(options.signal);
    let response: ProviderResult;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: retries are intentionally sequential.
      response = await client(request, {
        maxBytes: MAX_RESPONSE_BYTES,
        signal: deadline.signal,
      });
      deadline.signal.throwIfAborted();
    } catch (error) {
      deadline.clear();
      classifyTransportFailure(error, deadline, options.signal);
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

    deadline.clear();
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 2) {
      return parsePage(response);
    }
    const delay = retryDelayMs(response, attempt);
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

/** Complete membership validation is internal; only returned tool results use the output cap. */
async function loadWorkspaceGroup(
  options: InstantlyApiOptions = {}
): Promise<InstantlyWorkspaceGroup> {
  const members: z.infer<typeof workspaceGroupMemberSchema>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_GROUP_PAGES; pageNumber += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Workspace Group cursors are sequential.
    const page = await callPage(
      {
        input: {
          limit: PAGE_LIMIT,
          ...(cursor === null ? {} : { starting_after: cursor }),
        },
        operation: "instantly.workspace-group-members",
      },
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

  const accepted = members.filter((member) => member.status === "accepted");
  if (
    new Set(accepted.map((member) => member.sub_workspace_id)).size !==
    accepted.length
  ) {
    throw new InstantlyApiError(
      "Instantly returned duplicate accepted workspace IDs.",
      { kind: "invalid-response" }
    );
  }
  return {
    adminWorkspace: {
      id: first.admin_workspace_id,
      name: first.admin_workspace_name,
    },
    excludedMemberships: {
      pending: members.filter((member) => member.status === "pending").length,
      rejected: members.filter((member) => member.status === "rejected").length,
    },
    subworkspaces: accepted.map((member) => ({
      id: member.sub_workspace_id,
      name: member.sub_workspace_name,
    })),
  };
}

export const instantlyWorkspaceDiscoverySchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum results, default 20. The byte limit may return fewer."),
  search: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Literal case-insensitive workspace name fragment. Omit to browse accepted workspaces."
    ),
  startingAfter: z
    .string()
    .uuid()
    .optional()
    .describe(
      "The previous nextStartingAfter cursor. Keep the same search when continuing."
    ),
});

type InstantlyWorkspaceDiscovery = z.infer<
  typeof instantlyWorkspaceDiscoverySchema
>;

interface InstantlyWorkspacePage extends InstantlyWorkspaceGroup {
  membershipComplete: true;
  nextStartingAfter: string | null;
  totalAcceptedSubworkspaces: number;
  totalMatches: number;
}

/** Search/page only after complete membership validation, within the public byte cap. */
export async function listInstantlySubworkspaces(
  options: InstantlyApiOptions = {},
  query: InstantlyWorkspaceDiscovery = {}
): Promise<InstantlyWorkspacePage> {
  const parsed = instantlyWorkspaceDiscoverySchema.safeParse(query);
  if (!parsed.success) {
    throw new InstantlyApiError(
      "Invalid Instantly workspace search or pagination input.",
      {
        kind: "invalid-input",
      }
    );
  }
  const group = await loadWorkspaceGroup(options);
  const { search, limit = 20, startingAfter } = parsed.data;
  const fragment = search === undefined ? undefined : normalizeName(search);
  const matches = group.subworkspaces
    .filter(
      (workspace) =>
        fragment === undefined ||
        (workspace.name !== null &&
          normalizeName(workspace.name).includes(fragment))
    )
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  const cursorIndex =
    startingAfter === undefined
      ? -1
      : matches.findIndex((workspace) => workspace.id === startingAfter);
  if (startingAfter !== undefined && cursorIndex === -1) {
    throw new InstantlyApiError(
      "The Instantly workspace cursor no longer matches this search. Restart discovery with the same name fragment.",
      { kind: "invalid-input" }
    );
  }
  const start = cursorIndex + 1;
  const page: InstantlyWorkspacePage = {
    adminWorkspace: group.adminWorkspace,
    excludedMemberships: group.excludedMemberships,
    membershipComplete: true,
    nextStartingAfter: null,
    subworkspaces: matches.slice(start, start + limit),
    totalAcceptedSubworkspaces: group.subworkspaces.length,
    totalMatches: matches.length,
  };
  // Names can be large. Trim the public page without discarding internal membership evidence.
  for (;;) {
    page.nextStartingAfter =
      start + page.subworkspaces.length < matches.length
        ? (page.subworkspaces.at(-1)?.id ?? null)
        : null;
    if (Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_RESPONSE_BYTES) {
      return page;
    }
    if (page.subworkspaces.length <= 1) {
      throw tooMuchData();
    }
    page.subworkspaces.pop();
  }
}

const resolveWorkspace = async (
  selector: InstantlyWorkspaceSelector,
  options: InstantlyApiOptions
): Promise<InstantlyWorkspace> => {
  const group = await loadWorkspaceGroup(options);
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

const resourceLimit = (value: number | undefined): number => {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw new InstantlyApiError(
      "Instantly resource limit must be an integer from 1 to 100.",
      { kind: "invalid-input" }
    );
  }
  return limit;
};

const resourceRequest = (
  resource: InstantlyResource,
  query: InstantlyResourceQuery,
  workspaceId: string,
  limit: number
): OperationRequest => {
  const input = {
    limit,
    search: query.search,
    starting_after: query.startingAfter,
    status: query.status,
    "x-as-workspace": workspaceId,
  };
  if (resource === "accounts") {
    return {
      input: { ...input, provider_code: query.providerCode },
      operation: "instantly.accounts",
    };
  }
  if (resource === "campaigns") {
    return { input, operation: "instantly.campaigns" };
  }
  return {
    input: {
      ...input,
      campaign_id: query.campaignId,
      eaccount: query.emailAccount,
      email_type: query.emailType,
      latest_of_thread: query.latestOfThread,
      lead: query.lead,
      max_timestamp_created: query.maxTimestampCreated,
      min_timestamp_created: query.minTimestampCreated,
      preview_only: true,
    },
    operation: "instantly.emails",
  };
};

/** Reads one bounded resource page as an accepted subworkspace. */
export async function readInstantlySubworkspace(
  selector: InstantlyWorkspaceSelector,
  resource: InstantlyResource,
  query: InstantlyResourceQuery = {},
  options: InstantlyApiOptions = {}
): Promise<InstantlyResourcePage> {
  // Validate the query before any membership request.
  const limit = resourceLimit(query.limit);
  const workspace = await resolveWorkspace(selector, options);
  const page = await callPage(
    resourceRequest(resource, query, workspace.id, limit),
    options
  );
  return enforceOutputBudget({
    items: sanitizeItems(resource, page.items),
    nextStartingAfter: page.next_starting_after ?? null,
    resource,
    workspace,
  });
}
