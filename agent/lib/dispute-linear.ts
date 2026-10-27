import type {
  DatabaseFacts,
  EvidenceDeps,
  StripeFacts,
} from "./dispute-evidence.js";
import { clip, rowList, type Source, str } from "./dispute-evidence-shared.js";
import { findRelatedIssues, linearGraphql } from "./linear-api.js";
import type { LinearResponse } from "./linear-response.js";

const MAX_TICKETS = 25;
const TEXT_CHARS = 1500;
const DESCRIPTION_CHARS = 4000;
const WHITESPACE = /\s+/u;
const ALL_WHITESPACE = /\s+/gu;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;
const normalize = (text: string) =>
  text.trim().toLowerCase().replace(ALL_WHITESPACE, " ");
const phraseIn = (text: string, value: string) => {
  const escaped = normalize(value).replace(REGEX_SPECIAL, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_@.+-])${escaped}(?![\\p{L}\\p{N}_@+-]|\\.[\\p{L}\\p{N}])`,
    "u"
  ).test(text);
};

/** Which customer identifiers a ticket names; empty when it names none of them. */
const ownershipRules = (
  stripe: Source<StripeFacts>,
  database: Source<DatabaseFacts>
) => {
  const rules: { rule: string; value: string }[] = [];
  const add = (
    rule: string,
    value: string | null | undefined,
    fullName = false
  ) => {
    if (
      value?.trim() &&
      (!fullName || value.trim().split(WHITESPACE).length >= 2)
    ) {
      rules.push({ rule, value });
    }
  };
  add("customerEmail", stripe.facts?.customer?.email);
  add("organizationId", database.facts?.provisioned?.organizationId);
  add("workspaceName", database.facts?.provisioned?.name, true);
  add("customerName", stripe.facts?.customer?.name, true);
  add("cardholderName", stripe.facts?.cardholder.name, true);
  for (const member of database.facts?.members?.rows ?? []) {
    add("memberEmail", str(member.email));
    if (member.role === "owner") {
      add("ownerName", str(member.name), true);
    }
  }
  return rules;
};

export const readLinear = async (
  deps: EvidenceDeps,
  stripe: Source<StripeFacts>,
  database: Source<DatabaseFacts>
) => {
  const phrases = [
    ...new Set(
      [
        stripe.facts?.customer?.email,
        stripe.facts?.cardholder.email,
        database.facts?.provisioned?.name,
      ]
        .map((phrase) => phrase?.trim().toLowerCase())
        .filter((phrase): phrase is string => Boolean(phrase))
    ),
  ];
  if (!phrases.length) {
    throw new Error(
      "No customer email or workspace name was read, so Linear could not be searched."
    );
  }
  const related = await findRelatedIssues(
    { phrases, scope: "duplicates", windowed: false },
    { client: deps.linear, signal: deps.abortSignal }
  );
  const found = related.issues.slice(0, MAX_TICKETS);
  const identifiers = found.map((issue) => issue.identifier);
  const requested = new Set(identifiers);
  const bodies = identifiers.length
    ? (
        await linearGraphql<LinearResponse<"IssueBodies">>(
          "IssueBodies",
          { filter: { id: { in: identifiers } } },
          { client: deps.linear, signal: deps.abortSignal }
        )
      ).issues.nodes
    : [];
  const requestedBodies = bodies.filter((body) =>
    requested.has(body.identifier)
  );
  const droppedUnrequested = bodies.length - requestedBodies.length;
  if (identifiers.length && !requestedBodies.length) {
    throw new Error(
      `Linear returned none of the ${identifiers.length} tickets the search found (${droppedUnrequested} unrequested); their text was not read.`
    );
  }
  const rules = ownershipRules(stripe, database);
  const tickets = requestedBodies.flatMap((body) => {
    const text = normalize(
      [
        body.title,
        body.description,
        ...body.comments.nodes.map((comment) => comment.body),
      ].join("\n")
    );
    const matchedOn = [
      ...new Set(
        rules
          .filter(({ value }) => phraseIn(text, value))
          .map(({ rule }) => rule)
      ),
    ];
    const comments = body.comments.nodes
      .map((comment) => ({
        author: comment.user?.name ?? null,
        body: clip(comment.body, TEXT_CHARS),
        createdAt: comment.createdAt,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const truncated =
      body.comments.nodes.length >= 10 ||
      (body.description?.length ?? 0) > DESCRIPTION_CHARS ||
      body.comments.nodes.some((comment) => comment.body.length > TEXT_CHARS);
    return [
      {
        comments,
        createdAt: body.createdAt,
        description: clip(body.description, DESCRIPTION_CHARS),
        identifier: body.identifier,
        matchedOn,
        state: body.state.name,
        title: body.title,
        truncated,
        url: body.url,
      },
    ];
  });
  return {
    droppedUnrequested,
    phrases,
    tickets: rowList(
      tickets,
      MAX_TICKETS,
      related.truncated ||
        related.issues.length > MAX_TICKETS ||
        tickets.some((ticket) => ticket.truncated)
    ),
  };
};
