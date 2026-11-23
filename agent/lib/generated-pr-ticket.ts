// Files the Fixy ticket for a PR a generator workflow opened (ENG-20297). Fixy reviews and merges those PRs; the
// `fixy` label is what starts its run, so it is added last, after the PR is attached for the run to find.

const LINEAR_URL = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 20_000;
const TEAM_KEY = "ENG";
const FIXY_LABEL = "fixy";
const PR_URL =
  /^https:\/\/github\.com\/Acquisity\/Foreman\/pull\/(?<number>\d{1,7})$/u;

export const GENERATED_PR_KINDS = {
  guide: {
    name: "widget guide",
    review:
      "check its whole guide change against the Help Centre docs at the Acquisity commit its guide header names",
  },
  tools: {
    name: "widget tools",
    review:
      "CI passes, and nothing is removed or renamed unless the manifest adds it as a new endpoint version",
  },
} as const;

export type GeneratedPrKind = keyof typeof GENERATED_PR_KINDS;

export type LinearRequest = <T>(
  query: string,
  variables: Record<string, unknown>
) => Promise<T>;

interface OpenTicket {
  id: string;
  identifier: string;
  labels: { nodes: { id: string }[] };
  state: { type: string };
}

const prNumber = (url: string): string => {
  const number = PR_URL.exec(url)?.groups?.number;
  if (!number) {
    throw new Error("The PR URL must be an Acquisity/Foreman pull request");
  }
  return number;
};

export const ticketTitle = (kind: GeneratedPrKind, url: string): string =>
  `Review and merge the generated ${GENERATED_PR_KINDS[kind].name} PR (Foreman#${prNumber(url)})`;

export const ticketDescription = (kind: GeneratedPrKind, url: string): string =>
  [
    `The ${GENERATED_PR_KINDS[kind].name} workflow opened ${url}. Its body names the Acquisity commit it was generated from.`,
    `Review it and merge it once the review-bot loop clears, as Fixy's instructions say (Aaron, 2026-11-23): ${GENERATED_PR_KINDS[kind].review}.`,
    "Later updates to the same PR reuse this ticket while it is open.",
  ].join("\n\n");

const CLOSED_STATES = new Set(["completed", "canceled"]);

const write = async (
  linear: LinearRequest,
  field: string,
  query: string,
  variables: Record<string, unknown>
): Promise<void> => {
  const result = await linear<Record<string, { success: boolean }>>(
    query,
    variables
  );
  if (!result[field]?.success) {
    throw new Error(`Linear did not confirm ${field}`);
  }
};

const addFixyLabel = (linear: LinearRequest, id: string, labelId: string) =>
  write(
    linear,
    "issueAddLabel",
    "mutation($id:String!,$label:String!){issueAddLabel(id:$id,labelId:$label){success}}",
    { id, label: labelId }
  );

// The ticket is found by the PR attachment, so a ticket a person moved, relabelled or retitled is still reused. A
// reused ticket without `fixy` gets it, so a label write that failed after the attachment is retried by the next run.
export const fileOrReuseTicket = async (
  linear: LinearRequest,
  kind: GeneratedPrKind,
  url: string
): Promise<{ identifier: string; reused: boolean; addedLabel: boolean }> => {
  const title = ticketTitle(kind, url);
  const found = await linear<{
    attachmentsForURL: { nodes: { issue: OpenTicket | null }[] };
    teams: { nodes: { id: string }[] };
    issueLabels: { nodes: { id: string; team: { id: string } | null }[] };
  }>(
    "query($url:String!,$team:String!,$label:String!){attachmentsForURL(url:$url){nodes{issue{id identifier state{type} labels{nodes{id}}}}} teams(filter:{key:{eq:$team}}){nodes{id}} issueLabels(filter:{name:{eq:$label}}){nodes{id team{id}}}}",
    { label: FIXY_LABEL, team: TEAM_KEY, url }
  );
  const teamId = found.teams.nodes[0]?.id;
  const labelId = found.issueLabels.nodes.find(
    (label) => !label.team || label.team.id === teamId
  )?.id;
  if (!(teamId && labelId)) {
    throw new Error(
      `Linear has no ${TEAM_KEY} team or no ${FIXY_LABEL} label for it`
    );
  }

  const open = found.attachmentsForURL.nodes
    .map((node) => node.issue)
    .find((ticket) => ticket && !CLOSED_STATES.has(ticket.state.type));
  if (open) {
    const addedLabel = !open.labels.nodes.some((label) => label.id === labelId);
    if (addedLabel) {
      await addFixyLabel(linear, open.id, labelId);
    }
    return { addedLabel, identifier: open.identifier, reused: true };
  }

  const created = await linear<{
    issueCreate: { issue: { id: string; identifier: string } | null };
  }>(
    "mutation($input:IssueCreateInput!){issueCreate(input:$input){issue{id identifier}}}",
    { input: { description: ticketDescription(kind, url), teamId, title } }
  );
  const { issue } = created.issueCreate;
  if (!issue) {
    throw new Error("Linear did not confirm issueCreate");
  }
  await write(
    linear,
    "attachmentCreate",
    "mutation($input:AttachmentCreateInput!){attachmentCreate(input:$input){success}}",
    {
      input: {
        issueId: issue.id,
        title: `Foreman#${prNumber(url)}`,
        url,
      },
    }
  );
  await addFixyLabel(linear, issue.id, labelId);
  return { addedLabel: true, identifier: issue.identifier, reused: false };
};

// A personal API key goes in the header as is; an OAuth or app token needs Bearer.
export const linearRequest =
  (key: string, fetchImpl: typeof fetch = fetch): LinearRequest =>
  async <T>(query: string, variables: Record<string, unknown>) => {
    const response = await fetchImpl(LINEAR_URL, {
      body: JSON.stringify({ query, variables }),
      headers: {
        Authorization: key.startsWith("lin_api_") ? key : `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
    });
    const body = (await response.json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (!response.ok || body.errors?.length || !body.data) {
      throw new Error(
        `Linear refused the request (${response.status}): ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`
      );
    }
    return body.data;
  };
