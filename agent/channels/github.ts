import {
  defaultGitHubAuth,
  type GitHubComment,
  githubChannel,
} from "eve/channels/github";
import type { InputRequest } from "eve/client";
import { FACTORY_BRANCH_PREFIX, FACTORY_LABEL } from "../lib/constants.js";
import { mentionPattern, resolveBotName } from "../lib/github/bot-name.js";
import { githubCredentials } from "../lib/github/credentials.js";
import { stampAutonomous, stampTrusted } from "../lib/trust.js";

/**
 * Commenter roles allowed to start a session by mentioning the agent.
 *
 * @remarks
 * GitHub's `author_association` on the comment payload. Anything outside this
 * set (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN) is a user the
 * repo hasn't trusted with write access, so their mentions are acknowledged
 * without dispatching.
 */
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

/**
 * Replicates the channel's built-in ignore rules: eve's own marker comments,
 * bot authors, and the agent's own `<bot>[bot]` login.
 */
const isIgnoredComment = (comment: GitHubComment, botName: string): boolean => {
  if (comment.body.includes("<!-- eve:github:")) {
    return true;
  }
  const { author } = comment;
  if (author === undefined) {
    return false;
  }
  return (
    author.type === "Bot" ||
    author.login.toLowerCase() === `${botName.toLowerCase()}[bot]`
  );
};

const isTrustedCommenter = (comment: GitHubComment): boolean => {
  const association = comment.raw.author_association;
  return (
    typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association)
  );
};

/**
 * Task injected into an unattended intake session (an issue labeled with the
 * factory label). The issue's content is already in the session's context
 * when this runs.
 */
const FACTORY_INTAKE_TASK = [
  `This issue was handed to the factory with the "${FACTORY_LABEL}" label, and this run is unattended: nobody is watching to answer a question or approve an action, so never use ask_question and never attempt an action that needs approval.`,
  "Run the work item through the full pipeline. If the classifier needs clarification, post its questions as a comment on the issue and stop; someone will re-label the issue when they've answered.",
  "Keep the requester in the loop as you go: post a short comment on this issue when a station completes, except the last one. Comments on this issue are the one conversational write this run has; you cannot comment anywhere else.",
  "Deliver the finished work as a draft pull request, then end the run with a reply that links it. The reply is delivered to this issue by the channel and replaces the progress comment for this final step; never announce the pull request with the comment tool.",
].join("\n\n");

/**
 * How many automated CI-fix attempts a factory pull request gets before the
 * factory pauses and hands the problem to a person.
 */
const MAX_CI_FIX_ATTEMPTS = 2;

/**
 * Task injected when a check suite fails on one of the factory's own pull
 * requests. The session is anchored to that pull request's thread.
 *
 * @remarks
 * The attempt cap is counted from the fix-attempt comments earlier runs
 * posted on the pull request, because each dispatch is a fresh session with
 * no memory of the last one: the thread is the only durable record they
 * share. That's also why the task posts the attempt comment before fixing,
 * not after; a run that dies mid-fix still leaves its mark for the next one
 * to count.
 */
const CI_FIX_TASK = [
  "A CI check suite failed on one of the factory's own pull requests. This run is unattended: nobody is watching to answer a question or approve an action, so never use ask_question and never attempt an action that needs approval.",
  "Before anything else, read the pull request and its check runs fresh. If the checks are green by now, or the failure belongs to a commit that is no longer the branch head, stop without posting anything.",
  `Count your own earlier fix-attempt comments on this pull request. If there are already ${MAX_CI_FIX_ATTEMPTS}, do not attempt another fix. Post one comment saying the factory is pausing its automated CI fixes on this pull request to avoid looping, ${MAX_CI_FIX_ATTEMPTS} attempts have not turned the checks green, and further troubleshooting needs a person. Then stop.`,
  "Otherwise, first post a short comment that a CI fix attempt is starting and what looks broken (future runs count these comments to know when to stop). Diagnose with github__getCiFailureContext, then run the fix as a revision: send the implementer the pull request's context, its branch name, and your diagnosis, and have the reviewer judge the updated branch. Pushing the fix re-runs the checks; do not open a new pull request.",
].join("\n\n");

/**
 * Longest value preview per input field in an approval prompt comment.
 *
 * @remarks
 * Clamping per field rather than per payload means a huge text field (a full
 * PR body, say) can never crowd out the short fields that carry the actual
 * decision, like `draft: false` on `updatePullRequest`.
 */
const MAX_FIELD_PREVIEW = 120;

/**
 * Tool-input fields left out of approval prompts: they are filled from
 * `FACTORY_REPO` by the extension's context and never carry the decision.
 */
const IMPLIED_INPUT_FIELDS = new Set(["owner", "repo"]);

/**
 * The thread the pending call targets, lifted out of the input and into the
 * prompt's headline (e.g. "on pull request #9").
 */
const describeTarget = (
  input: Record<string, unknown>
): { key: string | null; suffix: string } => {
  if (typeof input.pullNumber === "number") {
    return {
      key: "pullNumber",
      suffix: ` on pull request #${input.pullNumber}`,
    };
  }
  if (typeof input.issueNumber === "number") {
    return { key: "issueNumber", suffix: ` on issue #${input.issueNumber}` };
  }
  return { key: null, suffix: "" };
};

/**
 * Renders one input-field value on a single line: whitespace flattened,
 * clamped to {@link MAX_FIELD_PREVIEW} with the full length noted, so the
 * approver sees the shape of every field without any one field taking over.
 */
const formatFieldValue = (value: unknown): string => {
  const rendered =
    typeof value === "string"
      ? value.replace(/\s+/gu, " ").trim()
      : JSON.stringify(value);
  if (rendered === undefined || rendered.length === 0) {
    return "(empty)";
  }
  if (rendered.length <= MAX_FIELD_PREVIEW) {
    return rendered;
  }
  return `${rendered.slice(0, MAX_FIELD_PREVIEW)}… (${rendered.length} chars)`;
};

/**
 * How to answer a prompt, appended to every input-request comment.
 *
 * @remarks
 * The mention requirement isn't decoration: every inbound comment passes
 * through `onComment`, which only dispatches mentions from owners, members,
 * and collaborators, so a bare "approve" never reaches the parked session.
 * That same gate is what makes a comment reply a real authorization signal
 * on a public repository.
 */
const responseFooter = (botName: string): string =>
  `Only repository owners, members, and collaborators can respond, and the reply must mention @${botName}; other replies are ignored.`;

/**
 * Renders one pending input request as comment markdown: what is waiting
 * (the tool, its target, and its remaining input as a per-field list for
 * approvals, the question otherwise) and exactly how to reply.
 */
const formatInputRequest = (request: InputRequest, botName: string): string => {
  const lines: string[] = [];
  if (request.kind === "tool-approval") {
    const target = describeTarget(request.action.input);
    lines.push(
      `Waiting for approval to run \`${request.action.toolName}\`${target.suffix}:`
    );
    const fields = Object.entries(request.action.input).filter(
      ([key]) => !IMPLIED_INPUT_FIELDS.has(key) && key !== target.key
    );
    if (fields.length > 0) {
      lines.push("");
      for (const [key, value] of fields) {
        lines.push(`- ${key}: ${formatFieldValue(value)}`);
      }
    }
  } else {
    lines.push(request.prompt);
  }
  const options = request.options ?? [];
  if (options.length > 0) {
    lines.push("");
    for (const option of options) {
      lines.push(
        `- Reply \`@${botName} ${option.label}\`${
          option.description ? `: ${option.description}` : ""
        }`
      );
    }
  } else if (request.kind === "tool-approval") {
    lines.push(
      "",
      `Reply \`@${botName} approve\` to allow it, or \`@${botName} deny\` to refuse.`
    );
  } else {
    lines.push("", `Reply \`@${botName}\` followed by your answer.`);
  }
  return lines.join("\n");
};

/**
 * Task injected into the session dispatched when a pull request opens. The
 * PR's metadata and changed-file patches are already in the session's context
 * when this runs; the repo itself is checked out into the sandbox.
 */
const PR_SUMMARY_TASK = [
  "A pull request was just opened. Post one comment that helps reviewers get oriented.",
  "Open with a short paragraph saying what the PR does and why, grounded in its title, description, and diff. Never guess at intent the diff doesn't show.",
  "Then add a markdown table breaking down the changed files: the file path, the kind of change (added, modified, removed, renamed), and what changed in one short phrase. For a very large PR, list the files that carry the substance and roll the rest into a final count row.",
  "Close with one line pointing reviewers at where to start. This comment is a summary, not a review: don't approve, request changes, or ask the author for anything.",
].join("\n\n");

/**
 * GitHub channel: the factory's main intake and delivery surface, as
 * "Foreman".
 *
 * @remarks
 * - Credentials are brokered by Vercel Connect through the shared handle in
 *   `agent/lib/github/credentials.ts`; tokens are resolved per call and never
 *   exposed to the model.
 * - The name the factory answers to is resolved at runtime from the GitHub
 *   App's own slug (`agent/lib/github/bot-name.ts`), so the mention follows
 *   whatever the deployer named their app with no configuration, and a
 *   hardcoded handle can't collide with an unrelated GitHub user.
 * - `onComment` replaces the built-in mention gate to add an authorization
 *   check: it keeps the default mention and ignore rules, then dispatches
 *   only when the commenter's `author_association` marks them as trusted with
 *   the repo (owner, member, or collaborator). The dispatch stamps the
 *   `trusted` auth attribute, which is what lets the approval policies run
 *   reversible writes without a card. Mentions from anyone else are
 *   acknowledged without a session, so arbitrary accounts on a public repo
 *   cannot drive the agent's write tools.
 * - `onIssue` is the unattended intake: adding the factory label hands the
 *   issue to the pipeline. Only the `labeled` action dispatches, never a
 *   label carried on `opened`, because issue templates let unauthenticated
 *   reporters attach labels at open time. The factory label is matched
 *   against the issue's current `labels` array rather than a single "added
 *   label" field, because eve exposes the issue object as `issue.raw`, not
 *   the raw webhook payload that carries the just-added label. Applying a
 *   label requires triage permission, so the trigger is maintainer-initiated,
 *   but the turn itself runs unattended: the auth is rewritten to the
 *   constructed autonomous principal with the intake issue number stamped in,
 *   and the approval policies deny it everything except labels, progress
 *   comments on that one issue, and draft pull requests.
 * - `onPullRequest` dispatches only on the `opened` action and skips PRs
 *   opened by bots, which covers Dependabot and the factory's own
 *   `foreman[bot]` pull requests. It is deliberately not gated by
 *   `author_association`: summarizing outside contributors' PRs is the point,
 *   and the injected task is scoped to posting a single summary comment.
 * - `onCheckSuite` is the red-CI fix loop, scoped to the factory's own work:
 *   it dispatches only when a suite completes with a failure conclusion on a
 *   pull request whose head branch carries the factory prefix, so a person's
 *   red PR never triggers an uninvited fix. The session runs unattended under
 *   the autonomous principal, anchored to the pull request, and the injected
 *   task bounds the loop by counting earlier fix-attempt comments on the
 *   thread. Requires the connector to subscribe to the `check_suite` webhook
 *   event.
 * - The `input.requested` handler posts a comment when a session parks on an
 *   approval or a question. The channel ships no built-in renderer for this
 *   event (as of eve 0.33), so without the handler a parked session waits
 *   silently, visible only in the run logs. The prompt spells out the reply
 *   incantation because `onComment` only forwards trusted mentions.
 */
export default githubChannel({
  botName: process.env.FACTORY_BOT_NAME ?? process.env.GITHUB_APP_SLUG,
  credentials: githubCredentials,
  events: {
    "input.requested": async (data, channel) => {
      const botName = await resolveBotName();
      const body = data.requests
        .map((request) => formatInputRequest(request, botName))
        .join("\n\n---\n\n");
      await channel.thread.post([body, responseFooter(botName)].join("\n\n"));
    },
  },
  onCheckSuite: (ctx, suite) => {
    const raw = suite.raw as {
      head_branch?: unknown;
      check_suite?: { head_branch?: unknown };
    };
    const headBranch = raw.head_branch ?? raw.check_suite?.head_branch;
    const [pullNumber] = suite.pullRequests;
    if (
      suite.action !== "completed" ||
      suite.conclusion !== "failure" ||
      pullNumber === undefined ||
      typeof headBranch !== "string" ||
      !headBranch.startsWith(FACTORY_BRANCH_PREFIX)
    ) {
      return null;
    }
    return {
      auth: stampAutonomous(defaultGitHubAuth(ctx), pullNumber),
      context: [CI_FIX_TASK],
    };
  },
  onComment: async (ctx, comment) => {
    const botName = await resolveBotName();
    return !isIgnoredComment(comment, botName) &&
      mentionPattern(botName).test(comment.body) &&
      isTrustedCommenter(comment)
      ? { auth: stampTrusted(defaultGitHubAuth(ctx)) }
      : null;
  },
  onIssue: (ctx, issue) => {
    const { labels } = issue.raw as {
      labels?: ReadonlyArray<{ name?: unknown }>;
    };
    const hasFactoryLabel =
      Array.isArray(labels) &&
      labels.some((entry) => entry?.name === FACTORY_LABEL);
    if (
      issue.action !== "labeled" ||
      !hasFactoryLabel ||
      ctx.sender.type === "Bot"
    ) {
      return null;
    }
    return {
      auth: stampAutonomous(defaultGitHubAuth(ctx), issue.issueNumber),
      context: [FACTORY_INTAKE_TASK],
    };
  },
  onPullRequest: (ctx, pullRequest) =>
    pullRequest.action === "opened" && ctx.sender.type !== "Bot"
      ? { auth: defaultGitHubAuth(ctx), context: [PR_SUMMARY_TASK] }
      : null,
});
