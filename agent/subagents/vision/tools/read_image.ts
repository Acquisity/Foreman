import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";

// Byte payloads have to cross eve's durable JSON boundary as base64, and the
// provider needs the media type declared, so it comes from the bytes, never
// from a name: a JSON error body saved as shot.png is the failure this tool
// exists to catch.
const MAGIC: Array<{ mediaType: string; test: (b: Buffer) => boolean }> = [
  {
    mediaType: "image/png",
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  {
    mediaType: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mediaType: "image/gif",
    test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  },
  {
    mediaType: "image/webp",
    test: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/** The media type the bytes declare, or null when they are not an image. */
export const sniffImage = (bytes: Buffer): string | null =>
  MAGIC.find(({ test }) => bytes.length >= 12 && test(bytes))?.mediaType ??
  null;

// eve warns above 3 MiB per content part, and providers reject beyond their own
// limits with an opaque error. Fail here instead, where the message names the file.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** The one remote host: Linear's upload store, read with the app token. */
export const LINEAR_UPLOAD_HOST = "uploads.linear.app";
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Wall-clock bound on draining one image's bytes, url or sandbox path alike.
 *
 * @remarks
 * eve 0.44's Vercel sandbox adapter drops the `abortSignal` it is handed on
 * `readFile`, so a sandbox read cannot be cancelled from the outside and a
 * stalled transfer would otherwise hold the turn open with nothing to wake it.
 * The bound is enforced here instead, on the reader Foreman owns: the deadline
 * cancels the stream, which is the layer that can actually stop the transfer.
 * Twenty seconds matches the url deadline and is far above a 3 MiB read.
 *
 * It bounds the draining only. Acquiring the stream, the `readFile` call that
 * returns it, is still bounded by nothing but the Vercel invocation ceiling,
 * for the reason recorded in `.github/OUTSIDE-CALLS.md`.
 */
const READ_TIMEOUT_MS = 20_000;

const notAnImage = (what: string, bytes: Buffer) => {
  const head = bytes.subarray(0, 120).toString("utf8").replace(/\s+/gu, " ");
  const hint = head.startsWith("{")
    ? " This is a JSON body, most likely Linear's 401 for an expired signed url; pass the uploads.linear.app url instead of a downloaded file."
    : "";
  return new Error(
    `${what} is not a PNG, JPEG, GIF, or WebP image (starts with: ${head.slice(0, 60)}).${hint}`
  );
};

/**
 * Load an image into this session's context.
 *
 * @remarks
 * This is the one tool that puts pixels in front of a model in Foreman, and it
 * is authored only inside the vision station so the image stays in the cheap
 * child's history rather than the orchestrator's. A Linear screenshot is read
 * straight from `uploads.linear.app` with the app token, so the parent never
 * downloads it and the 300-second url signature never matters.
 */
export default defineTool({
  description:
    "Look at an image. Pass url for a Linear screenshot (an uploads.linear.app link from the issue; read with Foreman's own Linear access, so it works after the link's signature has expired) or path for a PNG, JPEG, GIF, or WebP file already in the sandbox. The bytes are checked before you see them; a failure names why.",
  async execute(input, ctx) {
    let bytes: Buffer;
    if ("url" in input) {
      bytes = await fetchLinearUpload(
        input.url,
        await ctx.getToken(linearAuth)
      );
    } else {
      const sandbox = await ctx.getSandbox();
      const stream = await sandbox.readFile({ path: input.path });
      if (stream === null) {
        throw new Error(`No file at ${input.path}.`);
      }
      bytes = await readBounded(stream, input.path);
    }
    const what = "url" in input ? input.url : input.path;
    const mediaType = sniffImage(bytes);
    if (!mediaType) {
      throw notAnImage(what, bytes);
    }
    return { base64: bytes.toString("base64"), mediaType, source: what };
  },
  inputSchema: z.union([
    z.object({
      url: z
        .string()
        .url()
        .max(2048)
        .refine(
          (value) => {
            const parsed = new URL(value);
            return (
              parsed.protocol === "https:" && parsed.host === LINEAR_UPLOAD_HOST
            );
          },
          {
            message: `Only https://${LINEAR_UPLOAD_HOST} urls can be read by url.`,
          }
        ),
    }),
    z.object({ path: z.string().min(1).max(1024) }),
  ]),
  toModelOutput: (output) =>
    toolOutput.content([
      toolOutputPart.text(`Image from ${output.source}:`),
      toolOutputPart.file(output.base64, { mediaType: output.mediaType }),
    ]),
});

async function fetchLinearUpload(
  url: string,
  auth: { token: string },
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await readPrefix(response.body, 160);
    throw new Error(
      `Linear returned HTTP ${response.status} for ${url} (${body}); the upload may have been deleted or Foreman's Linear access does not cover it. This request carried Foreman's own token, so the link's signature age is not the cause.`
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`${url} is over the 3 MiB limit for one image.`);
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  return readBounded(response.body, url);
}

export { fetchLinearUpload, readBounded };

/** The first `chars` of a body, reading one chunk and cancelling the rest. */
async function readPrefix(
  body: ReadableStream<Uint8Array> | null,
  chars: number
): Promise<string> {
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  try {
    const { value } = await reader.read();
    return Buffer.from(value ?? new Uint8Array())
      .toString("utf8")
      .slice(0, chars)
      .replace(WHITESPACE, " ");
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

const WHITESPACE = /\s+/gu;

/**
 * Streamed and checked chunk by chunk rather than read whole and measured
 * after, so a path that names something enormous (a core dump, a tarball
 * with an image extension) costs one chunk over the limit, not its size.
 *
 * @remarks
 * One {@link READ_TIMEOUT_MS} deadline covers the whole read, not each chunk:
 * it is armed once and every chunk races the same expiry, so a source that
 * dribbles a byte at a time is bounded exactly like one that stalls outright.
 * The stream is read through its own reader rather than `for await` precisely
 * so the deadline can cancel it: `for await` locks the stream, and a locked
 * stream refuses to be cancelled.
 *
 * Cancellation is started in `finally` and deliberately not awaited. A source
 * whose `cancel` never settles would otherwise hold this function open
 * forever, which is the hang the deadline exists to end.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  what: string,
  timeoutMs: number = READ_TIMEOUT_MS
): Promise<Buffer> {
  const reader = stream.getReader();
  const deadline = AbortSignal.timeout(timeoutMs);
  const expired = new Promise<never>((_resolve, reject) => {
    deadline.addEventListener("abort", () =>
      reject(
        new Error(
          `${what} did not finish reading within ${timeoutMs / 1000} seconds.`
        )
      )
    );
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: chunks arrive in order, and each one is raced against the deadline.
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) {
        return Buffer.concat(chunks);
      }
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        throw new Error(
          `${what} is over the 3 MiB limit for one image. Resize or crop it first.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
