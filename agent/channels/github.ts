import {
  defaultGitHubAuth,
  type GitHubComment,
  githubChannel,
} from "eve/channels/github";
import { mentionPattern, resolveBotName } from "../lib/github/bot-name.js";
import { githubCredentials } from "../lib/github/credentials.js";
import { stampRepository } from "../lib/repository.js";
import { stampTrusted } from "../lib/trust.js";

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

// Trusted explicit mentions are the only GitHub intake. Issue, pull-request
// and CI handlers are opt-in in eve, so omitting them ignores those webhooks.
export default githubChannel({
  botName: resolveBotName,
  credentials: githubCredentials,
  onComment: async (ctx, comment) => {
    // Resolve inside request handling, where Connect's deployment identity is
    // available. A failure ignores this event and lets the next one retry.
    const botName = await resolveBotName().catch(() => null);
    if (
      botName === null ||
      isIgnoredComment(comment, botName) ||
      !isTrustedCommenter(comment) ||
      !mentionPattern(botName).test(comment.body)
    ) {
      return null;
    }
    return {
      auth: stampTrusted(
        stampRepository(
          defaultGitHubAuth(ctx),
          ctx.repository.fullName,
          "github-webhook"
        )
      ),
    };
  },
});
