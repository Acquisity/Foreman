/** Read a request body as text, or null once it exceeds 8 KB. */
export async function readRequestBody(request: Request) {
  if (!request.body) {
    return "";
  }
  const reader = request.body.pipeThrough(new TextDecoderStream()).getReader();
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
    reader.cancel().catch(() => undefined);
  }
}
