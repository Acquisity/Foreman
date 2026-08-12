import { createHash } from "node:crypto";
import { FACTORY_REPO } from "./constants.js";

/**
 * Reserved Blob path prefix for the shared factory brain.
 *
 * @remarks
 * The factory-brain tools own this prefix exclusively. Any general-purpose Blob tool must treat
 * it as off-limits (see `isReservedBrainPath` / `isReservedBrainUrl`) so it can't be used as a
 * side channel to read or overwrite the shared brain: the brain is only reachable through the
 * `read_factory_brain` and `update_factory_brain` tools, and only trusted callers may write.
 */
export const FACTORY_BRAIN_PREFIX = "factory-brain/";

/**
 * Maximum size of the factory-brain document, in characters.
 *
 * @remarks
 * The brain is a short, curated set of durable notes about the target repository, not a
 * transcript of every run. The bound keeps it small and cheap to load into context at the start
 * of every task.
 */
export const MAX_FACTORY_BRAIN_LENGTH = 40_000;

/**
 * Whether a Blob pathname falls under the reserved factory-brain prefix.
 *
 * @param pathname - A Blob object pathname (no leading slash), e.g. `drafts/post.md`.
 * @returns `true` when the path is reserved for the factory brain.
 */
export const isReservedBrainPath = (pathname: string): boolean =>
  pathname.startsWith(FACTORY_BRAIN_PREFIX);

/** Leading slashes stripped from a URL pathname before the reserved-prefix check. */
const LEADING_SLASHES = /^\/+/;

/**
 * Whether a Blob URL points at a reserved factory-brain object.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path, so the reserved-prefix check
 * applies to the URL's pathname. Unparseable input is treated as not reserved; the caller's own
 * URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns `true` when the URL addresses a reserved factory-brain object.
 */
export const isReservedBrainUrl = (url: string): boolean => {
  try {
    return isReservedBrainPath(
      new URL(url).pathname.replace(LEADING_SLASHES, "")
    );
  } catch {
    return false;
  }
};

/**
 * Resolve the Blob key holding the factory brain for the target repository.
 *
 * @remarks
 * The key is derived entirely from {@link FACTORY_REPO} (resolved at module load), never from
 * model input or a caller's principal, so every session on one deployment reads and writes the
 * same shared document. Keying on the target repository scopes the brain to the code it
 * describes: a single-repo deployment has exactly one brain, and a deployment that later targets
 * another repository gets a separate brain rather than mixing facts across codebases. The
 * repository slug is hashed so the stored path carries no raw `owner/repo` in the object name.
 *
 * @returns The reserved Blob key for this factory's brain.
 */
export const factoryBrainKey = (): string => {
  const id = createHash("sha256").update(FACTORY_REPO).digest("hex");
  return `${FACTORY_BRAIN_PREFIX}${id}.md`;
};
