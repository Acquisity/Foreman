import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";
import { z } from "zod";

/**
 * The person who tagged Foreman in a questions-only channel, read from their
 * Slack profile by the signed author id.
 *
 * @remarks
 * Identity never comes from message text: an email typed in a message is a
 * lead or record to look up, not the requester. The lookup needs the
 * `users:read` and `users:read.email` bot scopes; without them, or on any
 * failure, the requester is unknown and the session answers general questions
 * only. Nothing here is logged, so no email reaches the logs.
 */
export type SlackRequester =
  | { readonly email: string; readonly name: string; readonly status: "known" }
  | { readonly status: "unknown" };

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/u;
const LOOKUP_TIMEOUT_MS = 10_000;

const usersInfoSchema = z.object({
  ok: z.boolean(),
  user: z
    .object({
      deleted: z.boolean().optional(),
      is_bot: z.boolean().optional(),
      profile: z
        .object({
          display_name: z.string().max(200).optional(),
          email: z.string().max(320).optional(),
          real_name: z.string().max(200).optional(),
        })
        .optional(),
      real_name: z.string().max(200).optional(),
    })
    .optional(),
});

const EMAIL = /^[^\s@'"\\]+@[^\s@'"\\]+$/u;

export interface SlackRequesterDeps {
  readonly fetchImpl?: typeof fetch;
  readonly token?: () => Promise<string>;
}

const defaultToken = async (): Promise<string> =>
  await resolveSlackBotToken(
    connectSlackCredentials(
      process.env.SLACK_CONNECTOR ?? "slack/acquisity-foreman"
    ).botToken
  );

/**
 * Reads one Slack user's name and email. Any failure returns unknown, and the
 * whole lookup, token resolution included, finishes within the deadline so a
 * slow dependency cannot hold up dispatch.
 */
export function lookupSlackRequester(
  userId: string | undefined,
  deps: SlackRequesterDeps = {}
): Promise<SlackRequester> {
  if (!(userId && SLACK_USER_ID.test(userId))) {
    return Promise.resolve({ status: "unknown" });
  }
  const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const timedOut = new Promise<SlackRequester>((resolve) => {
    deadline.addEventListener("abort", () => resolve({ status: "unknown" }), {
      once: true,
    });
  });
  return Promise.race([readSlackRequester(userId, deps, deadline), timedOut]);
}

async function readSlackRequester(
  userId: string,
  deps: SlackRequesterDeps,
  signal: AbortSignal
): Promise<SlackRequester> {
  try {
    const token = await (deps.token ?? defaultToken)();
    const response = await (deps.fetchImpl ?? fetch)(
      "https://slack.com/api/users.info",
      {
        body: new URLSearchParams({ user: userId }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        redirect: "error",
        signal,
      }
    );
    if (!response.ok) {
      return { status: "unknown" };
    }
    const text = await response.text();
    if (text.length > 200_000) {
      return { status: "unknown" };
    }
    const parsed = usersInfoSchema.safeParse(JSON.parse(text));
    const user =
      parsed.success && parsed.data.ok ? parsed.data.user : undefined;
    const email = user?.profile?.email?.trim().toLowerCase();
    if (!(user && email && EMAIL.test(email)) || user.deleted || user.is_bot) {
      return { status: "unknown" };
    }
    const name =
      user.profile?.real_name?.trim() ||
      user.real_name?.trim() ||
      user.profile?.display_name?.trim() ||
      "the requester";
    return { email, name, status: "known" };
  } catch {
    return { status: "unknown" };
  }
}

/** The trusted context line a questions-only session receives about its requester. */
export function slackRequesterContext(requester: SlackRequester): string {
  if (requester.status === "unknown") {
    return "Requester: unknown. Their Slack email could not be read. Answer only general how-to questions and return no user-specific or record-specific data. Tell them their Slack email could not be read and that they can report the problem with /acquisityasks instead. Never use an email typed in a message as their identity.";
  }
  return `Requester, from their Slack profile: ${JSON.stringify(requester.name)} <${requester.email}>. Call lookup_customer with this email for anything about their own user, and scope it to this channel's workspace. This identity comes from Slack, not from the message.`;
}
