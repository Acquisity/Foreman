import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileOrReuseTicket,
  type LinearRequest,
  ticketTitle,
} from "./generated-pr-ticket.js";

const PR = "https://github.com/Acquisity/Foreman/pull/274";
const OPERATION = /\{(\w+)/u;

// Shaped like Linear's measured answers: attachmentsForURL, teams and issueLabels (fixy is workspace-wide).
const fakeLinear = () => {
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
            .map((issue) => ({ issue })),
        },
      });
    }
    if (op === "teams") {
      return Promise.resolve({
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

  assert.deepEqual(result, { identifier: "ENG-900", reused: false });
  assert.deepEqual(linear.calls, [
    "attachmentsForURL",
    "teams",
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
    identifier: "ENG-900",
    reused: true,
  });
  assert.equal(linear.issues.length, 1);

  const [first] = linear.issues;
  if (first) {
    first.state.type = "completed";
  }
  assert.deepEqual(await fileOrReuseTicket(linear.request, "guide", PR), {
    identifier: "ENG-901",
    reused: false,
  });
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
