import type { SessionAuthContext } from "eve/context";
import { acquisityOrigin } from "./fin-context.js";
import { requireWidgetContext } from "./widget-scope.js";

/** Fixed read-only app routes; all authority comes from the verified chat. */
export async function readWidgetAppDiagnostics(
  ctx: {
    abortSignal: AbortSignal;
    session?: { auth: { initiator: SessionAuthContext | null } };
  },
  kind: "website",
  input: Record<string, unknown>,
  request: typeof fetch = fetch
): Promise<unknown> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const secret = process.env.FOREMAN_DIAGNOSTICS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("App diagnostics are not configured.");
  }
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(25_000),
  ]);
  const response = await request(
    `${acquisityOrigin()}/api/internal/foreman/${kind}`,
    {
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
    }
  );
  if (response.status !== 200) {
    response.body?.cancel().catch(() => undefined);
    throw new Error(`App diagnostic request failed (${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("App diagnostic response is missing.");
  }
  const abort = () => reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      // biome-ignore lint/performance/noAwaitInLoops: bounded response stream.
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 64 * 1024) {
        throw new Error("App diagnostic response is too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.cancel().catch(() => undefined);
  }
}
