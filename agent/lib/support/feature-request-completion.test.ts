import assert from "node:assert/strict";
import { test } from "node:test";
import { SupportRefusal } from "./errors.js";
import { assertTriageOutputs } from "./triage-completion.js";

/** Completion for feature requests and repeats left for grouping (ENG-15932, ENG-17138). */

const report = {
  assignee: "Area Owner",
  documents: [{ id: "document-1", title: "Triage investigation" }],
  id: "ENG-13629",
  labels: ["intercom-sourced", "Customer reported", "Bug"],
  parentId: "ENG-13136",
  priority: { value: 2 },
  project: "Core Platform",
  status: "Todo",
};
const document = {
  content: `# Triage investigation\n**Classification**: Bug\n**Review**: Approved 2026-09-10T12:00:00Z at ${"a".repeat(40)}`,
  url: "https://linear.app/acquisity/document/investigation-1",
};
const comments = [
  {
    body: `The failure is routed. [Triage investigation](${document.url})`,
    id: "comment-1",
  },
];

test("completion accepts a Feature Request waiting in Backlog and refuses one closed without a person declining it (ENG-15932)", () => {
  const waiting = {
    ...report,
    assignee: "James Keeble",
    labels: [
      "intercom-sourced",
      "Customer reported",
      "Feature Request",
      "Needs approval",
    ],
    parentId: null,
    project: null,
    status: "Backlog",
  };
  const content = {
    ...document,
    content:
      "# Triage investigation\n**Classification**: Feature Request\n**Handling path**: Feature Request\n**Review**: Not required",
  };
  assert.doesNotThrow(() => assertTriageOutputs(waiting, content, comments));
  for (const status of ["Canceled", "Done", "Duplicate"]) {
    assert.throws(
      () => assertTriageOutputs({ ...waiting, status }, content, comments),
      SupportRefusal,
      status
    );
  }
  assert.doesNotThrow(() =>
    assertTriageOutputs(
      {
        ...waiting,
        assignee: null,
        labels: [...waiting.labels, "Declined"],
        status: "Canceled",
      },
      content,
      comments
    )
  );
  assert.throws(
    () =>
      assertTriageOutputs(
        {
          ...waiting,
          labels: waiting.labels.filter((label) => label !== "Feature Request"),
        },
        content,
        comments
      ),
    SupportRefusal
  );
});

test("completion accepts an Approved Feature Request a person resolved Done, as the router allows (C3)", () => {
  const resolved = {
    ...report,
    assignee: null,
    labels: [
      "intercom-sourced",
      "Customer reported",
      "Feature Request",
      "Approved",
    ],
    parentId: null,
    project: null,
    status: "Done",
  };
  const content = {
    ...document,
    content:
      "# Triage investigation\n**Classification**: Feature Request\n**Handling path**: Resolved by triage\n**Review**: Not required",
  };
  assert.doesNotThrow(() => assertTriageOutputs(resolved, content, comments));
});

test("completion accepts a repeat report left open in Backlog for grouping (C6)", () => {
  for (const classification of ["User Error", "Bug"]) {
    const grouped = {
      ...report,
      assignee: "Aaron Fraga",
      labels: [
        "intercom-sourced",
        "Customer reported",
        ...(classification === "Bug" ? ["Bug"] : []),
        "Needs grouping",
      ],
      parentId: null,
      project: null,
      status: "Backlog",
    };
    const content = {
      ...document,
      content: `# Triage investigation\n**Classification**: ${classification}\n**Handling path**: Duplicate\n**Review**: Approved 2026-09-10T12:00:00Z at ${"a".repeat(40)}`,
    };
    assert.doesNotThrow(
      () => assertTriageOutputs(grouped, content, comments),
      classification
    );
  }
});

test("completion accepts a declined Feature Request Canceled without Needs approval (R5)", () => {
  const declined = {
    ...report,
    assignee: null,
    labels: [
      "intercom-sourced",
      "Customer reported",
      "Feature Request",
      "Declined",
    ],
    parentId: null,
    project: null,
    status: "Canceled",
  };
  const content = {
    ...document,
    content:
      "# Triage investigation\n**Classification**: Feature Request\n**Handling path**: Declined\n**Review**: Not required",
  };
  assert.doesNotThrow(() => assertTriageOutputs(declined, content, comments));
});

const CLOSED_UNSEEN =
  /A Feature Request closes only on a person's matching decision/u;

test("completion matches a closed Feature Request's state to the person's decision", () => {
  // Every fixture is valid apart from the closed-unseen rule: an Area label
  // for the engineering path and a duplicate relation for Duplicate, so the
  // refusal can only come from that rule.
  const closed = (status: string, decisions: string[], path: string) => ({
    report: {
      ...report,
      assignee: null,
      labels: [
        "intercom-sourced",
        "Customer reported",
        "Feature Request",
        "Area: AI SDR",
        ...decisions,
      ],
      parentId: null,
      project: null,
      relations: status === "Duplicate" ? { duplicateOf: "ENG-9" } : null,
      status,
    },
    written: {
      ...document,
      content: `# Triage investigation\n**Classification**: Feature Request\n**Handling path**: ${path}\n**Review**: Not required`,
    },
  });
  const refused: [string, string[], string][] = [
    ["Canceled", ["Approved"], "Resolved by triage"],
    ["Done", ["Declined"], "Declined"],
    ["Duplicate", ["Approved"], "Duplicate"],
    ["Done", ["Approved"], "Engineering Todo"],
    ["Done", ["Approved", "Declined"], "Resolved by triage"],
  ];
  for (const [status, decisions, path] of refused) {
    const { report: issue, written } = closed(status, decisions, path);
    const next = decisions.includes("Declined")
      ? /route it to Canceled/u
      : /Route it to Backlog with Needs approval/u;
    assert.throws(
      () => assertTriageOutputs(issue, written, comments),
      (error: unknown) =>
        error instanceof SupportRefusal &&
        CLOSED_UNSEEN.test(error.message) &&
        next.test(error.message),
      `${status} with ${decisions.join("+")} on ${path}`
    );
  }
  const accepted: [string, string[], string][] = [
    ["Canceled", ["Declined"], "Declined"],
    ["Done", ["Approved"], "Resolved by triage"],
  ];
  for (const [status, decisions, path] of accepted) {
    const { report: issue, written } = closed(status, decisions, path);
    assert.doesNotThrow(
      () => assertTriageOutputs(issue, written, comments),
      `${status} with ${decisions.join("+")} on ${path}`
    );
  }
});
