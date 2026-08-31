import { isConnectionAuthorizationFailedError } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { SIGN_IN_CONNECTIONS, signInAuth } from "#lib/sign-in.js";
import { isUnattended } from "#lib/trust.js";
import { SLACK_SIGN_IN_REASON } from "#lib/user-connect.js";

/**
 * Deliberate, attended-only escape hatch from the Slack sign-in denial.
 *
 * @remarks
 * Every user-scoped connection authorizes through `userConnect`, which turns
 * a missing grant into a terminal failure for Slack-issued sessions so a
 * turn can never park on a consent prompt nobody asked for. This tool is the
 * one place a person can intentionally ask for that consent flow: it probes
 * the connection's wrapped authorization first and only when the failure is
 * exactly the known Slack denial does it resolve the unwrapped
 * authorization, whose missing grant raises "authorization required" and
 * lets the runtime park the turn on sign-in. On resume the probe succeeds
 * and the tool reports the connection as connected.
 *
 * Every other failure (a revoked grant, an unreachable provider, a missing
 * user principal) propagates unchanged, so this tool never converts a real
 * error into a consent prompt. Unattended sessions are refused before any
 * token is requested: nobody is watching to complete a consent flow. The
 * resolved token never appears in the output.
 */
export default defineTool({
  description:
    "Connect a service for this user when they explicitly ask to sign in or connect it. " +
    "Starts the service's consent flow and waits for the person to complete it. " +
    "Use only on an intentional request from a person watching the session; " +
    "unattended sessions are refused. Never use it to work around a connection " +
    "failure the person did not ask to fix.",
  async execute({ connection }, ctx) {
    const auth = ctx.session.auth.current;
    if (isUnattended(auth) || auth?.principalType !== "user") {
      return {
        connected: false,
        error:
          "Sign-in needs a person watching this session; unattended runs cannot complete a consent flow.",
      };
    }
    const entry = signInAuth(connection);
    if (!entry) {
      return {
        connected: false,
        error: `${connection} does not use per-user sign-in.`,
      };
    }
    try {
      await ctx.getToken(entry.wrapped);
      return { connected: true };
    } catch (error) {
      const slackDenial =
        isConnectionAuthorizationFailedError(error) &&
        error.reason === SLACK_SIGN_IN_REASON;
      if (!slackDenial) {
        throw error;
      }
    }
    // The one consent path: the unwrapped definition raises "authorization
    // required" for the missing grant and the runtime parks the turn on the
    // sign-in flow. Reaching the return means the grant resolved inline.
    await ctx.getToken(entry.consent);
    return { connected: true };
  },
  inputSchema: z.strictObject({
    connection: z
      .enum(SIGN_IN_CONNECTIONS)
      .describe("The one service to connect."),
  }),
  outputSchema: z.strictObject({
    connected: z.boolean(),
    error: z.string().optional(),
  }),
});
