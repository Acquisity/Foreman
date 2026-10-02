const MAX_CONTEXT_BYTES = 4096;
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/** Require one configured HTTPS origin before sending it a user's identity token; loopback http only outside production. */
export function acquisityOrigin(): string {
  const configured = process.env.ACQUISITY_ORIGIN;
  const url = configured ? URL.parse(configured) : null;
  const localHttp =
    url?.protocol === "http:" &&
    LOOPBACK.has(url.hostname) &&
    process.env.NODE_ENV !== "production";
  if (
    !url ||
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("ACQUISITY_ORIGIN is not configured.");
  }
  return url.origin;
}

/** Keep the deadline active while consuming a streamed HTTP response. */
export async function readContextBody(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > MAX_CONTEXT_BYTES) {
    response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid verified workspace context.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Invalid verified workspace context.");
  }
  const abort = () => reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      // biome-ignore lint/performance/noAwaitInLoops: bound and consume one response stream in order.
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_CONTEXT_BYTES) {
        throw new Error("Invalid verified workspace context.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.cancel().catch(() => undefined);
  }
}
