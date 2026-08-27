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
      bytes = await readAll(stream, input.path);
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
        .refine((value) => new URL(value).host === LINEAR_UPLOAD_HOST, {
          message: `Only ${LINEAR_UPLOAD_HOST} urls can be read by url.`,
        }),
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
    throw new Error(
      `Linear returned HTTP ${response.status} for ${url}; the upload may have been deleted or Foreman's Linear access does not cover it.`
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`${url} is over the 3 MiB limit for one image.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`${url} is over the 3 MiB limit for one image.`);
  }
  return bytes;
}

export { fetchLinearUpload };

/**
 * Streamed and checked chunk by chunk rather than read whole and measured
 * after, so a path that names something enormous (a core dump, a tarball
 * with an image extension) costs one chunk over the limit, not its size.
 */
async function readAll(
  stream: AsyncIterable<Uint8Array>,
  path: string
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      throw new Error(
        `${path} is over the 3 MiB limit for one image. Resize or crop it first.`
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
