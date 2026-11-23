import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileOrReuseTicket,
  type LinearRequest,
  linearRequest,
  ticketTitle,
} from "./generated-pr-ticket.js";

const PR = "https://github.com/Acquisity/Foreman/pull/274";
const OPERATION = /\{(\w+)/u;
const LABEL_UNCONFIRMED = /did not confirm issueAddLabel/u;
const NOT_FOUND = /Entity not found/u;

// Shaped like Linear's measured answers: attachmentsForURL, teams and issueLabels (fixy is workspace-wide).
const fakeLinear = (failLabelWrites = 0) => {
  let labelFailures = failLabelWrites;
  const issues: {
    id: string;
    identifier: string;
    state: { type: string };
    title: string;
    urls: string[];
    labels: string[];
  }[] = [];
  const calls: string[] = [];
  const request = ((query: string, variables: Record<string, unknown>) => {
    const op = OPERATION.exec(query.slice(query.indexOf(")") + 1))?.[1] ?? "";
    calls.push(op);
    const input = variables.input as Record<string, string> | undefined;
    if (op === "attachmentsForURL") {
      return Promise.resolve({
        attachmentsForURL: {
          nodes: issues
            .filter((i) => i.urls.includes(variables.url as string))
            .map((issue) => ({
              issue: {
                ...issue,
                labels: { nodes: issue.labels.map((id) => ({ id })) },
              },
            })),
        },
        issueLabels: { nodes: [{ id: "label-fixy", team: null }] },
        teams: { nodes: [{ id: "team-eng" }] },
      });
    }
    if (op === "issueCreate") {
      const issue = {
        id: `id-${issues.length + 1}`,
        identifier: `ENG-${900 + issues.length}`,
        labels: [],
        state: { type: "triage" },
        title: input?.title ?? "",
        urls: [],
      };
      issues.push(issue);
      return Promise.resolve({ issueCreate: { issue } });
    }
    if (op === "attachmentCreate") {
      issues.find((i) => i.id === input?.issueId)?.urls.push(input?.url ?? "");
      return Promise.resolve({ attachmentCreate: { success: true } });
    }
    if (op === "issueAddLabel") {
      if (labelFailures > 0) {
        labelFailures -= 1;
        return Promise.resolve({ issueAddLabel: { success: false } });
      }
      issues
        .find((i) => i.id === variables.id)
        ?.labels.push(variables.label as string);
      return Promise.resolve({ issueAddLabel: { success: true } });
    }
    throw new Error(`unexpected ${op}`);
  }) as LinearRequest;
  return { calls, issues, request };
};

test("a new PR files one fixy ticket with the PR attached before the label starts Fixy", async () => {
  const linear = fakeLinear();
  const result = await fileOrReuseTicket(linear.request, "guide", PR);

  assert.deepEqual(result, {
    addedLabel: true,
    identifier: "ENG-900",
    reused: false,
  });
  assert.deepEqual(linear.calls, [
    "attachmentsForURL",
    "issueCreate",
    "attachmentCreate",
    "issueAddLabel",
  ]);
  assert.deepEqual(linear.issues[0]?.urls, [PR]);
  assert.deepEqual(linear.issues[0]?.labels, ["label-fixy"]);
  assert.equal(
    linear.issues[0]?.title,
    "Review and merge the generated widget guide PR (Foreman#274)"
  );
});

test("an updated PR reuses its open ticket, and a closed one gets a new ticket", async () => {
  const linear = fakeLinear();
  await fileOrReuseTicket(linear.request, "guide", PR);

  assert.deepEqual(await fileOrReuseTicket(linear.request, "guide", PR), {
    addedLabel: false,
    identifier: "ENG-900",
    reused: true,
  });
  assert.equal(linear.issues.length, 1);

  const [first] = linear.issues;
  if (first) {
    first.state.type = "completed";
  }
  assert.deepEqual(await fileOrReuseTicket(linear.request, "guide", PR), {
    addedLabel: true,
    identifier: "ENG-901",
    reused: false,
  });
});

test("a fixy label write that failed is retried on the reused ticket", async () => {
  const linear = fakeLinear(1);
  await assert.rejects(
    fileOrReuseTicket(linear.request, "guide", PR),
    LABEL_UNCONFIRMED
  );
  assert.deepEqual(linear.issues[0]?.labels, []);

  assert.deepEqual(await fileOrReuseTicket(linear.request, "guide", PR), {
    addedLabel: true,
    identifier: "ENG-900",
    reused: true,
  });
  assert.deepEqual(linear.issues[0]?.labels, ["label-fixy"]);
  assert.equal(linear.issues.length, 1);
});

test("a personal key is sent as is, an app token as Bearer, and GraphQL errors throw", async () => {
  const sent: string[] = [];
  const fakeFetch = ((_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers).get("Authorization") ?? "");
    const body =
      sent.length === 3
        ? { errors: [{ message: "Entity not found" }] }
        : { data: { viewer: { id: "v" } } };
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;

  assert.deepEqual(
    await linearRequest("lin_api_personal", fakeFetch)("{viewer{id}}", {}),
    { viewer: { id: "v" } }
  );
  await linearRequest("lin_oauth_app", fakeFetch)("{viewer{id}}", {});
  await assert.rejects(
    linearRequest("lin_oauth_app", fakeFetch)("{viewer{id}}", {}),
    NOT_FOUND
  );
  assert.deepEqual(sent, [
    "lin_api_personal",
    "Bearer lin_oauth_app",
    "Bearer lin_oauth_app",
  ]);
});

test("only a Foreman PR URL is accepted", () => {
  assert.equal(
    ticketTitle("tools", "https://github.com/Acquisity/Foreman/pull/9"),
    "Review and merge the generated widget tools PR (Foreman#9)"
  );
  assert.throws(() =>
    ticketTitle("tools", "https://github.com/Acquisity/Acquisity/pull/9")
  );
});
