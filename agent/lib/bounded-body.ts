/**
 * Read a request body as text, or null once it exceeds 8 KB. A deadline bounds
 * the total read so a client that trickles bytes slowly (staying under the size
 * cap) cannot hold the route open: when it fires, the reader is cancelled, the
 * pending read rejects, and the caller treats the request as unreadable.
 */
export async function readRequestBody(request: Request, timeoutMs = 10_000) {
  if (!request.body) {
    return "";
  }
  const reader = request.body.pipeThrough(new TextDecoderStream()).getReader();
  const deadline = AbortSignal.timeout(timeoutMs);
  const onDeadline = () => {
    reader.cancel(deadline.reason).catch(() => undefined);
  };
  deadline.addEventListener("abort", onDeadline, { once: true });
  let body = "";
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: bound the streamed request before parsing it.
      const { done, value } = await reader.read();
      if (done) {
        return body;
      }
      if (body.length + value.length > 8192) {
        return null;
      }
      body += value;
    }
  } finally {
    deadline.removeEventListener("abort", onDeadline);
    reader.cancel().catch(() => undefined);
  }
}
