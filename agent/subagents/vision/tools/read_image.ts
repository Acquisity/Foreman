import { extname } from "node:path";
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

// Byte payloads have to cross eve's durable JSON boundary as base64, and the
// provider needs the media type declared, so the extension has to name a format
// the model can actually decode.
const MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// eve warns above 3 MiB per content part, and providers reject beyond their own
// limits with an opaque error. Fail here instead, where the message names the file.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Load an image from the shared sandbox into this session's context.
 *
 * @remarks
 * This is the one tool that puts pixels in front of a model in Foreman, and it
 * is authored only inside the vision station so the image stays in the cheap
 * child's history rather than the orchestrator's.
 */
export default defineTool({
  description:
    "Load an image from the sandbox so you can look at it. Takes an absolute path, or one relative to /workspace. PNG, JPEG, GIF, or WebP.",
  /**
   * Read the file as bytes and hand it back base64-encoded.
   *
   * @param input - Validated tool input.
   * @param ctx - Runtime context, used for the shared sandbox handle.
   * @returns The encoded image, its media type, and the path it came from.
   */
  async execute({ path }, ctx) {
    const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!mediaType) {
      throw new Error(
        `Cannot read ${path}: expected one of ${Object.keys(MEDIA_TYPES).join(", ")}.`
      );
    }
    const sandbox = await ctx.getSandbox();
    const stream = await sandbox.readFile({ path });
    if (stream === null) {
      throw new Error(`No file at ${path}.`);
    }
    // Streamed and checked chunk by chunk rather than read whole and measured
    // after, so a path that names something enormous (a core dump, a tarball
    // with an image extension) costs one chunk over the limit, not its size.
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
    return {
      base64: Buffer.concat(chunks).toString("base64"),
      mediaType,
      path,
    };
  },
  inputSchema: z.object({
    path: z.string().min(1).max(1024),
  }),
  toModelOutput: (output) =>
    toolOutput.content([
      toolOutputPart.text(`Image at ${output.path}:`),
      toolOutputPart.file(output.base64, { mediaType: output.mediaType }),
    ]),
});
