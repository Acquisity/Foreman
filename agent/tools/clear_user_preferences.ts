import { defineTool } from "eve/tools";
import { z } from "zod";
import { deleteDocument } from "#lib/blob.js";
import { userPreferencesDeletionPolicy } from "#lib/github/approval.js";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes the current user's saved preferences.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (`ctx.session.auth.current`),
 * never from model input, so a session can only ever clear its own user's preferences.
 * Deletion is irreversible, but an attended user asking for it in the session is the
 * authorization, so there is no card: one cannot be answered from Slack, and it would
 * park that session permanently. `userPreferencesDeletionPolicy` denies unattended
 * runs instead, because a schedule dispatching under a real user principal reads
 * attacker-writable tracker content and has no such request behind it.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  approval: userPreferencesDeletionPolicy,
  description:
    "Permanently delete this user's saved preferences. Use only when the user " +
    "explicitly asks to reset or forget their preferences. This is irreversible.",
  /**
   * Delete the current user's preferences file, if any.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns `deleted: true` when a file was removed, `false` when there was nothing to remove,
   * or `success: false` with an `error`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        deleted: false,
        error: "No signed-in user to clear preferences for.",
        success: false,
      };
    }
    try {
      const { existed } = await deleteDocument(key);
      return { deleted: existed, success: true };
    } catch (error) {
      return {
        deleted: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
  }),
});
