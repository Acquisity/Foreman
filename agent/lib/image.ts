// Byte payloads have to cross eve's durable JSON boundary as base64, and the
// provider needs the media type declared, so it comes from the bytes, never
// from a name: a JSON error body saved as shot.png is the failure this check
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
