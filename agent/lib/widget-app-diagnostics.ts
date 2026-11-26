import type { SessionAuthContext } from "eve/context";
import { acquisityOrigin } from "./acquisity-origin.js";
import { requireWidgetContext, type WidgetContext } from "./widget-scope.js";

export interface WidgetAppContext {
  abortSignal: AbortSignal;
  session?: { auth: { initiator: SessionAuthContext | null } };
}

/**
 * The one request contract for Acquisity's `/api/internal/foreman/*` routes:
 * the dedicated service secret, and the verified chat's ids over any input.
 */
export async function postScopedAppRoute(
  scope: Pick<WidgetContext, "conversationId" | "organizationId" | "userId">,
  path: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  request: typeof fetch
): Promise<Response> {
  const secret = process.env.FOREMAN_DIAGNOSTICS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("App diagnostics are not configured.");
  }
  return await request(`${acquisityOrigin()}${path}`, {
    body: JSON.stringify({
      ...input,
      conversationId: scope.conversationId,
      organizationId: scope.organizationId,
      userId: scope.userId,
    }),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal,
  });
}

/** {@link postScopedAppRoute} for a tool call, under the session's own abort and a deadline. */
export async function postWidgetAppRoute(
  ctx: WidgetAppContext,
  path: string,
  input: Record<string, unknown>,
  timeoutMs: number,
  request: typeof fetch
): Promise<{ response: Response; signal: AbortSignal }> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const response = await postScopedAppRoute(
    scope,
    path,
    input,
    signal,
    request
  );
  return { response, signal };
}
