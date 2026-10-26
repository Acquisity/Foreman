/**
 * Shared plumbing for the live Preview smoke checks (ENG-16248).
 *
 * @remarks
 * Every check drives a real front door (the Preview Slack app, the Preview
 * Linear app, or the Acquisity QA Preview's support API), proves which build
 * answered by matching the workflow run's deployment to the deployment the
 * `--url` alias serves, and reads tool calls and turn status from that run's
 * session stream through `t.target.attachSession`. Run them with
 * `pnpm eval --tag preview --url <Foreman QA Preview>`; without credentials
 * each check skips and names what is missing.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const exec = promisify(execFile);
const TEAM = "team_ZU8UTsvGgsLZaLDc8pUAzict";
export const QA_BRANCH = process.env.QA_PREVIEW_BRANCH ?? "qa/foreman-preview";
export const SLACK_CHANNEL = "C0BUF4GU8C8";
export const PREVIEW_BOT = "U0BTGKF57T7";
const FOREMAN_PREVIEW_LINEAR_USER = "5aa94691-1ea8-4cbf-8ca2-15e3671181fc";
const DEMO_WORKSPACE = "demo-workspace-9fvh_";
const CLI_DEADLINE_MS = 120_000;

/** Two deterministic computations, as `routing/native-delegation` uses. */
export const COMPUTATIONS = [
  { command: "printf 'FIRST=%s\\n' \"$((17 + 25))\"", line: "FIRST=42" },
  {
    command: `word=raven; reversed=; for ((i=4; i>=0; i--)); do reversed+="\${word:i:1}"; done; printf 'SECOND=%s\\n' "$reversed"`,
    line: "SECOND=nevar",
  },
] as const;

export const DELEGATION_ASK = `Use the native agent tool twice for two independent tasks. First agent call: run exactly this one read-only bash command: ${COMPUTATIONS[0].command}. Second agent call: run exactly this one read-only bash command: ${COMPUTATIONS[1].command}. Each child returns only its printed line. Then call eve__task_wait until both children finish; do not use sleep. Reply once, with both result lines on separate lines.`;

/**
 * Skips the check unless every named variable is set and the target is a
 * deployment, so `pnpm validate` and local runs never post anywhere.
 */
export function requireQa(
  t: EveEvalContext,
  ...names: string[]
): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    t.skip(`missing ${missing.join(", ")}`);
  }
  if (t.target.kind !== "remote") {
    t.skip("needs --url <Foreman QA Preview>");
  }
  return Object.fromEntries(
    names.map((name) => [name, process.env[name] ?? ""])
  );
}

/** A unique token placed early in each message, so its run can be found. */
export const marker = () => `qa-${randomUUID().slice(0, 8)}`;

async function cli(file: string, args: string[]): Promise<unknown> {
  const { stdout } = await exec(file, args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLI_DEADLINE_MS,
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

export interface Build {
  deploymentId: string;
  sha: string;
}

/** The deployment the `--url` alias serves, which must be the QA branch. */
export async function previewBuild(t: EveEvalContext): Promise<Build> {
  const { host } = new URL(t.target.url);
  const deployment = (await cli("npx", [
    "vercel",
    "api",
    `/v13/deployments/${host}?teamId=${TEAM}`,
    "--scope",
    "acquisity",
  ])) as {
    id: string;
    meta?: { githubCommitRef?: string; githubCommitSha?: string };
    readyState: string;
  };
  await t.require(
    deployment.readyState === "READY" &&
      deployment.meta?.githubCommitRef === QA_BRANCH,
    satisfies(Boolean, `${host} serves a READY ${QA_BRANCH} deployment`)
  );
  const build = {
    deploymentId: deployment.id,
    sha: deployment.meta?.githubCommitSha ?? "",
  };
  t.log(`build ${build.deploymentId} at ${build.sha}`);
  return build;
}

interface RunRow {
  deploymentId: string;
  runId: string;
  workflowName: string;
}

/**
 * Whether a session's first received message carries `needle`, read from its
 * recorded history without following or touching the session; undefined
 * while that cannot be read yet. Session titles cannot be used:
 * Slack sessions are titled "Private message".
 */
async function carries(
  t: EveEvalContext,
  runId: string,
  needle: string
): Promise<boolean | undefined> {
  const response = await t.target
    .fetch(`/eve/v1/session/${runId}/stream?follow=false`, {
      signal: AbortSignal.timeout(30_000),
    })
    .catch(() => undefined);
  // A session that is still starting can refuse a read; ask again next poll.
  if (!response?.ok) {
    return;
  }
  const received = (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { data?: unknown; type: string })
    .find((event) => event.type === "message.received");
  // Compare in JSON form, where the needle's own quotes are escaped too.
  return (
    received &&
    JSON.stringify(received.data).includes(JSON.stringify(needle).slice(1, -1))
  );
}

/**
 * Waits up to `waitMs` for the one root session run on `channel` whose first
 * message carries `needle`, then gates on its deployment being `build`. A run
 * that never appears fails the check.
 */
export async function matchRun(
  t: EveEvalContext,
  build: Build,
  channel: "linear" | "slack" | "widget",
  needle: string,
  since: Date,
  waitMs = 300_000
): Promise<string> {
  const deadline = Date.now() + waitMs;
  const checked = new Map<string, boolean>();
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polls until the run appears.
    const { data } = (await cli("npx", [
      "workflow",
      "inspect",
      "runs",
      "-b",
      "vercel",
      "-e",
      "preview",
      "--project",
      "foreman",
      "--team",
      "acquisity",
      "--since",
      since.toISOString(),
      "--attribute",
      `$eve.trigger=channel:${channel}`,
      "--limit",
      "100",
      "-j",
    ])) as { data: RunRow[] };
    const fresh = data.filter(
      (row) =>
        row.workflowName.endsWith("//workflowEntry") && !checked.has(row.runId)
    );
    const found = await Promise.all(
      fresh.map((row) => carries(t, row.runId, needle))
    );
    for (const [index, row] of fresh.entries()) {
      if (found[index] !== undefined) {
        checked.set(row.runId, found[index]);
      }
    }
    const runs = data.filter((row) => checked.get(row.runId));
    const [run] = runs;
    if (runs.length > 1 || run || Date.now() > deadline) {
      await t.require(
        runs.length === 1,
        satisfies(Boolean, `exactly one session run carries ${needle}`)
      );
    }
    if (run) {
      t.log(`run ${run.runId} on ${run.deploymentId}`);
      await t.require(
        run.deploymentId === build.deploymentId,
        satisfies(Boolean, `the run's deployment is ${build.deploymentId}`)
      );
      return run.runId;
    }
    await sleep(10_000, undefined, { signal: t.signal });
  }
}

/** Final text of the last settled assistant message in `events`. */
export const finalText = (
  events: readonly { data?: unknown; type: string }[]
): string =>
  events
    .filter((event) => event.type === "message.completed")
    .map((event) => event.data as { finishReason?: string; message?: string })
    .filter((data) => data.finishReason !== "tool-calls" && data.message)
    .at(-1)?.message ?? "";

// Slack, as the QA user, in the sandbox channel only.

interface SlackMessage {
  text?: string;
  ts: string;
  user?: string;
}

async function slack<T>(method: string, body: Record<string, string>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    body: new URLSearchParams(body),
    headers: { authorization: `Bearer ${process.env.QA_SLACK_TOKEN}` },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as T & { error?: string; ok: boolean };
  if (!result.ok) {
    throw new Error(`Slack ${method} failed: ${result.error}`);
  }
  return result;
}

export const postSlack = async (text: string, threadTs?: string) =>
  (
    await slack<{ ts: string }>("chat.postMessage", {
      channel: SLACK_CHANNEL,
      text: `<@${PREVIEW_BOT}> ${text}`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    })
  ).ts;

/** The Preview bot's replies in a thread, oldest first. */
export const botReplies = async (threadTs: string) =>
  (
    await slack<{ messages: SlackMessage[] }>("conversations.replies", {
      channel: SLACK_CHANNEL,
      limit: "200",
      ts: threadTs,
    })
  ).messages.filter((message) => message.user === PREVIEW_BOT);

/**
 * The bot's thread replies once one satisfies `done`, or after 30 s, since a
 * reply can land a moment after its turn settles.
 */
export async function settledReplies(
  threadTs: string,
  done: (message: SlackMessage) => boolean,
  signal: AbortSignal
): Promise<SlackMessage[]> {
  for (let attempt = 0; ; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polls until the reply lands.
    const replies = await botReplies(threadTs);
    if (attempt === 6 || replies.some(done)) {
      return replies;
    }
    await sleep(5000, undefined, { signal });
  }
}

// Linear, with the Sandbox-only key: issues are created, delegated and
// cancelled in team SAN and nowhere else.

export async function linear<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    body: JSON.stringify({ query, variables }),
    headers: {
      authorization: process.env.LINEAR_SANDBOX_API_KEY ?? "",
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!result.data || result.errors?.length) {
    throw new Error(
      `Linear: ${result.errors?.[0]?.message ?? response.status}`
    );
  }
  return result.data;
}

export interface SandboxIssue {
  anchorId: string;
  id: string;
  identifier: string;
}

/**
 * Files a SAN issue shaped like the sandbox receiver's (title, "Ask from"
 * attachment, anchor comment) and delegates it to Foreman Preview.
 */
export async function fileSandboxIssue(
  title: string,
  description: string,
  requester?: string
): Promise<SandboxIssue> {
  const { teams } = await linear<{ teams: { nodes: { id: string }[] } }>(
    `query { teams(filter: { key: { eq: "SAN" } }) { nodes { id } } }`
  );
  const teamId = teams.nodes[0]?.id;
  if (!teamId) {
    throw new Error("Team SAN is not readable with LINEAR_SANDBOX_API_KEY.");
  }
  const { issueCreate } = await linear<{
    issueCreate: { issue: { id: string; identifier: string } };
  }>(
    "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }",
    { input: { description, teamId, title } }
  );
  const { id, identifier } = issueCreate.issue;
  try {
    const anchorId = requester ? await askFrom(id, requester) : "";
    await linear(
      "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      { id, input: { delegateId: FOREMAN_PREVIEW_LINEAR_USER } }
    );
    return { anchorId, id, identifier };
  } catch (error) {
    await cancelIssue(id);
    throw error;
  }
}

/** The receiver's "Ask from" attachment and anchor comment; the anchor's id. */
async function askFrom(id: string, requester: string): Promise<string> {
  await linear(
    "mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }",
    {
      input: {
        issueId: id,
        title: `Ask from ${requester}`,
        url: `https://acquisityworkspace.slack.com/archives/C0BLFDUN6Q7/p${Date.now()}000`,
      },
    }
  );
  const { commentCreate } = await linear<{
    commentCreate: { comment: { id: string } };
  }>(
    "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }",
    {
      input: {
        body: "Slack thread connected in #sandbox-acquisityasks-feedback",
        issueId: id,
      },
    }
  );
  return commentCreate.comment.id;
}

/** Cancels a SAN issue, with a comment saying why. */
export async function cancelIssue(id: string): Promise<void> {
  const { issue } = await linear<{
    issue: { team: { states: { nodes: { id: string }[] } } };
  }>(
    `query($id: String!) { issue(id: $id) { team { states(filter: { type: { eq: "canceled" } }) { nodes { id } } } } }`,
    { id }
  );
  await linear(
    "mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }",
    { body: "Preview smoke check (ENG-16248) cleanup.", id }
  );
  await linear(
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id, input: { stateId: issue.team.states.nodes[0]?.id } }
  );
}

/** Foreman Preview's comments under the anchor (its requester replies). */
export async function requesterReplies(issue: SandboxIssue) {
  const data = await linear<{
    issue: {
      comments: {
        nodes: {
          body: string;
          parent: { id: string } | null;
          user: { id: string } | null;
        }[];
      };
      documents: { nodes: { title: string }[] };
    };
  }>(
    "query($id: String!) { issue(id: $id) { documents { nodes { title } } comments(first: 100) { nodes { body parent { id } user { id } } } } }",
    { id: issue.id }
  );
  return {
    documents: data.issue.documents.nodes.map((doc) => doc.title),
    replies: data.issue.comments.nodes.filter(
      (comment) =>
        comment.parent?.id === issue.anchorId &&
        comment.user?.id === FOREMAN_PREVIEW_LINEAR_USER
    ),
  };
}

// The Acquisity QA Preview's support API, called from inside a signed-in
// Orca browser tab (its session cookie is httpOnly), as the QA user in the
// demo workspace.

export interface SupportMessage {
  authorKind: string;
  foremanTurn?: string | null;
  id: string;
  stopped: boolean;
  text: string;
}

export interface Support {
  conversationId?: string;
  get: () => Promise<SupportMessage[]>;
  send: (text: string, investigate?: boolean) => Promise<string>;
  stop: () => Promise<boolean>;
}

export async function supportClient(
  base: string,
  page: string
): Promise<Support> {
  const call = async <T>(
    path: string,
    init: { body?: string; method?: string } = {}
  ): Promise<T> => {
    const expression = `fetch(${JSON.stringify(new URL(path, base))}, { ...${JSON.stringify(init)}, credentials: "include", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000) }).then(async (r) => JSON.stringify({ status: r.status, body: await r.text() }))`;
    // orca-ide exits non-zero on a page error but still prints its JSON.
    const { stdout } = await exec(
      "orca-ide",
      ["eval", "--page", page, "--expression", expression, "--json"],
      { timeout: 60_000 }
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));
    const evaluated = JSON.parse(stdout) as {
      error?: { message: string };
      result?: { result: string };
    };
    if (!evaluated.result) {
      throw new Error(`Orca page ${page}: ${evaluated.error?.message}`);
    }
    const response = JSON.parse(evaluated.result.result) as {
      body: string;
      status: number;
    };
    if (response.status >= 300) {
      throw new Error(`Acquisity ${path.split("?")[0]}: ${response.status}`);
    }
    return JSON.parse(response.body) as T;
  };
  const organizations = await call<{ id: string; slug: string }[]>(
    "/api/auth/organization/list"
  );
  const organizationId = organizations.find(
    (org) => org.slug === DEMO_WORKSPACE
  )?.id;
  if (!organizationId) {
    throw new Error(`The QA user is not a member of ${DEMO_WORKSPACE}.`);
  }
  const trpc = async <T>(procedure: string, input: object, mutation: boolean) =>
    (
      await call<{ result: { data: { json: T } } }>(
        mutation
          ? `/api/trpc/support.${procedure}`
          : `/api/trpc/support.${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
        mutation
          ? { body: JSON.stringify({ json: input }), method: "POST" }
          : undefined
      )
    ).result.data.json;
  const support: Support = {
    get: async () =>
      (
        await trpc<{ messages: SupportMessage[] }>(
          "get",
          { conversationId: support.conversationId, organizationId },
          false
        )
      ).messages,
    async send(text, investigate = true) {
      const sent = await trpc<{ conversationId: string; messageId: string }>(
        "send",
        {
          organizationId,
          text,
          ...(support.conversationId
            ? { conversationId: support.conversationId }
            : {}),
          ...(investigate ? { mode: "investigate" } : {}),
        },
        true
      );
      support.conversationId = sent.conversationId;
      return sent.messageId;
    },
    stop: async () =>
      (
        await trpc<{ ok: boolean }>(
          "stop",
          { conversationId: support.conversationId, organizationId },
          true
        )
      ).ok,
  };
  return support;
}

/**
 * Waits until Foreman finishes with `messageId` and returns its reply, the
 * first Foreman message after it, or null when it finished without one.
 */
export async function supportReply(
  support: Support,
  messageId: string,
  signal: AbortSignal
): Promise<SupportMessage | null> {
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polls until Foreman finishes.
    const messages = await support.get();
    const index = messages.findIndex((message) => message.id === messageId);
    // The customer message carries foremanTurn while Foreman works on it.
    if (index !== -1 && !messages[index]?.foremanTurn) {
      return (
        messages
          .slice(index + 1)
          .find((message) => message.authorKind === "foreman") ?? null
      );
    }
    await sleep(5000, undefined, { signal });
  }
}

/** An Investigate ask the demo workspace can answer from its own data. */
export const WIDGET_ASK =
  "Are any of my campaigns failing to send emails right now? A short answer is fine.";
