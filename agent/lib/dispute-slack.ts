import type {
  DatabaseFacts,
  EvidenceDeps,
  StripeFacts,
} from "./dispute-evidence.js";
import {
  clip,
  num,
  type Obj,
  obj,
  rowList,
  type Source,
  str,
} from "./dispute-evidence-shared.js";
import type { ProviderClient } from "./executor/operations.js";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 14;
const MAX_CHANNEL_PAGES = 40;
const MAX_HISTORY_PAGES = 5;
const MAX_THREADS = 20;
const MAX_SLACK_USERS = 30;
const AUTHOR_BATCH = 5;
const TEXT_CHARS = 1500;
const WORKSPACE_SUFFIX = /['’]s workspace$/iu;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/u;
/** Mailbox providers whose domain names no client. */
const FREE_MAIL = new Set([
  "aol",
  "gmail",
  "googlemail",
  "hotmail",
  "icloud",
  "live",
  "mac",
  "me",
  "msn",
  "outlook",
  "proton",
  "protonmail",
  "yahoo",
]);

// --- AI Acquisition client channel -----------------------------------------------

/** One Slack read; Slack answers HTTP 200 with `ok: false` on errors. */
const slackCall = async (
  deps: EvidenceDeps,
  request: Parameters<ProviderClient>[0]
): Promise<Obj> => {
  const response = await deps.slack(request);
  const data = obj(response.data);
  if (response.status !== 200 || data.ok !== true) {
    throw new Error(
      `Slack ${request.operation.slice(10)} failed (${str(data.error) ?? `HTTP ${response.status}`}).`
    );
  }
  return data;
};

/** Lowercase letters and digits joined by hyphens, as Slack names channels. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");

/** The terms a client channel name is matched on: workspace name and email domain. */
export const channelTerms = (
  workspaceName: string | null,
  emails: (string | null)[],
  names: (string | null)[] = []
): string[] => {
  const terms = new Set<string>();
  const name = workspaceName
    ? slug(workspaceName.replace(WORKSPACE_SUFFIX, ""))
    : "";
  // One word ("growth", "test") names too many channels to identify a client.
  if (name.includes("-")) {
    terms.add(name);
  }
  for (const person of names) {
    const full = person ? slug(person) : "";
    if (full.includes("-")) {
      terms.add(full);
    }
  }
  for (const email of emails) {
    const domain = email?.split("@")[1]?.toLowerCase();
    if (domain?.includes(".") && !FREE_MAIL.has(domain.split(".")[0] ?? "")) {
      terms.add(slug(domain));
    }
  }
  return [...terms];
};

const messageFacts = (message: Obj) => ({
  replyCount: num(message.reply_count) ?? 0,
  text: clip(message.text, TEXT_CHARS),
  threadTs: str(message.thread_ts),
  time: (() => {
    const ts = Number(str(message.ts));
    return Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
  })(),
  truncated: (str(message.text)?.length ?? 0) > TEXT_CHARS,
  ts: str(message.ts),
  user: str(message.user) ?? str(message.bot_id),
});

type SlackMessage = ReturnType<typeof messageFacts>;

/** Every page of private channels, matched by name; null when the list was cut off. */
const matchChannels = async (deps: EvidenceDeps, terms: string[]) => {
  const matches: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: cursors are sequential.
    const data = await slackCall(deps, {
      input: {
        limit: 200,
        types: "private_channel",
        ...(cursor ? { cursor } : {}),
      },
      operation: "slack.aia.channels",
    });
    for (const raw of (data.channels as unknown[] | undefined) ?? []) {
      const channel = obj(raw);
      const id = str(channel.id);
      const name = str(channel.name);
      if (
        id &&
        name &&
        terms.some((term) => `-${slug(name)}-`.includes(`-${term}-`))
      ) {
        matches.push({ id, name });
      }
    }
    cursor = str(obj(data.response_metadata).next_cursor) ?? undefined;
    pages += 1;
  } while (cursor && pages < MAX_CHANNEL_PAGES);
  return { complete: !cursor, matches };
};

/** The channel's messages since `oldest`, then the replies in its threads. */
const readChannel = async (
  deps: EvidenceDeps,
  channel: string,
  oldest: number
) => {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: cursors are sequential.
    const data = await slackCall(deps, {
      input: {
        channel,
        latest: String(deps.now() / 1000),
        limit: 200,
        oldest: oldest.toFixed(6),
        ...(cursor ? { cursor } : {}),
      },
      operation: "slack.aia.history",
    });
    messages.push(
      ...((data.messages as unknown[] | undefined) ?? []).map((raw) =>
        messageFacts(obj(raw))
      )
    );
    cursor = str(obj(data.response_metadata).next_cursor) ?? undefined;
    pages += 1;
  } while (cursor && pages < MAX_HISTORY_PAGES);
  const threads = messages.filter((message) => message.replyCount > 0);
  const replies: SlackMessage[] = [];
  let repliesCut = false;
  for (const parent of threads.slice(0, MAX_THREADS)) {
    if (!parent.ts) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one Slack read at a time.
    const data = await slackCall(deps, {
      input: { channel, limit: 200, ts: parent.ts },
      operation: "slack.aia.replies",
    });
    repliesCut ||=
      data.has_more === true ||
      Boolean(str(obj(data.response_metadata).next_cursor));
    replies.push(
      ...((data.messages as unknown[] | undefined) ?? [])
        .map((raw) => messageFacts(obj(raw)))
        .filter((reply) => reply.ts !== parent.ts)
    );
  }
  return {
    cut:
      Boolean(cursor) ||
      repliesCut ||
      threads.length > MAX_THREADS ||
      [...messages, ...replies].some((message) => message.truncated),
    messages: [...messages, ...replies].sort((a, b) =>
      (a.ts ?? "").localeCompare(b.ts ?? "")
    ),
  };
};

/**
 * Display names for message authors. Names are a convenience, not evidence:
 * a failed lookup leaves the name null and never fails the source.
 */
const authorNames = async (deps: EvidenceDeps, messages: SlackMessage[]) => {
  const names = new Map<string, string | null>();
  const users = [
    ...new Set(
      messages
        .map((message) => message.user)
        .filter((user): user is string => SLACK_USER.test(user ?? ""))
    ),
  ].slice(0, MAX_SLACK_USERS);
  let unresolved = 0;
  for (let start = 0; start < users.length; start += AUTHOR_BATCH) {
    // biome-ignore lint/performance/noAwaitInLoops: a few Slack reads at a time.
    await Promise.all(
      users.slice(start, start + AUTHOR_BATCH).map(async (user) => {
        try {
          const data = await slackCall(deps, {
            input: { user },
            operation: "slack.aia.user",
          });
          const profile = obj(data.user);
          names.set(
            user,
            str(obj(profile.profile).real_name) ??
              str(profile.real_name) ??
              str(profile.name)
          );
        } catch {
          unresolved += 1;
        }
      })
    );
  }
  return { names, unresolved };
};

export const readSlack = async (
  deps: EvidenceDeps,
  stripe: Source<StripeFacts>,
  database: Source<DatabaseFacts>
) => {
  const terms = channelTerms(
    database.facts ? (database.facts.provisioned?.name ?? null) : null,
    stripe.facts ? [stripe.facts.customer?.email ?? null] : [],
    [
      stripe.facts?.customer?.name ?? null,
      stripe.facts?.cardholder.name ?? null,
      ...(database.facts?.members?.rows ?? [])
        .filter((row) => row.role === "owner")
        .map((row) => str(row.name)),
    ]
  );
  const chargeDate = stripe.facts ? stripe.facts.charge.created : null;
  if (terms.length === 0 || !chargeDate) {
    throw new Error(
      "No workspace name, company email domain, or charge date was read, so the client channel could not be matched."
    );
  }
  const { complete, matches } = await matchChannels(deps, terms);
  if (!complete) {
    throw new Error(
      "The client channel listing is incomplete; no channel was read."
    );
  }
  if (matches.length === 0) {
    return {
      channel: null as { id: string; name: string } | null,
      messages: rowList([], 0),
      reason:
        "No client channel was found in the complete listing; refund promises and faults in that channel remain unverified.",
      terms,
      unavailable: [],
      unresolvedAuthors: 0,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      "The client channel match is ambiguous; no channel was read."
    );
  }
  const [channel] = matches;
  const oldest = (Date.parse(chargeDate) - HISTORY_DAYS * DAY_MS) / 1000;
  const read = await readChannel(deps, channel.id, oldest);
  const authors = await authorNames(deps, read.messages);
  return {
    channel: { id: channel.id, name: channel.name },
    from: new Date(oldest * 1000).toISOString(),
    messages: rowList(
      read.messages.map((message) => ({
        ...message,
        author: message.user ? (authors.names.get(message.user) ?? null) : null,
      })),
      read.messages.length,
      read.cut
    ),
    terms,
    unavailable: [],
    unresolvedAuthors: authors.unresolved,
  };
};
