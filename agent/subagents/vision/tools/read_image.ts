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
    const bytes = await sandbox.readBinaryFile({ path });
    if (bytes === null) {
      throw new Error(`No file at ${path}.`);
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `${path} is ${Math.round(bytes.byteLength / 1024)} KiB, over the 3 MiB limit for one image. Resize or crop it first.`
      );
    }
    return {
      base64: Buffer.from(bytes).toString("base64"),
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
