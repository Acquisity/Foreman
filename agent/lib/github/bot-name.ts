import { getConnectorMetadata } from "@vercel/connect";
import { GITHUB_CONNECTOR } from "./credentials.js";

/**
 * Name used when nothing better can be resolved: no env override and no
 * reachable connector metadata. Matches the template's default persona.
 */
const FALLBACK_BOT_NAME = "Foreman";

/**
 * Upper bound on a resolved bot name before it is interpolated into a
 * regular expression; GitHub App slugs are far shorter in practice.
 */
const MAX_BOT_NAME_LENGTH = 80;

let resolvedFromConnector: string | undefined;

/**
 * The name the factory answers to in `@mentions`, resolved without setup.
 *
 * @remarks
 * Resolution order:
 * 1. `FACTORY_BOT_NAME`, then `GITHUB_APP_SLUG`, for explicit overrides.
 * 2. The GitHub App's own slug from the Connect connector's metadata
 *    (`vendor.appSlug`), so the mention automatically follows whatever the
 *    deployer named their app. Fetched lazily with the deployment's OIDC
 *    token and cached for the life of the instance.
 * 3. {@link FALLBACK_BOT_NAME} when the metadata is unreachable; the failure
 *    is not cached, so a transient outage doesn't pin the fallback.
 *
 * A hardcoded name is wrong here because the app's slug is chosen by whoever
 * registers it, and a guessed handle can belong to a real GitHub user.
 */
export async function resolveBotName(): Promise<string> {
  const override = process.env.FACTORY_BOT_NAME ?? process.env.GITHUB_APP_SLUG;
  if (override) {
    return override;
  }
  if (resolvedFromConnector !== undefined) {
    return resolvedFromConnector;
  }
  try {
    const metadata = await getConnectorMetadata(GITHUB_CONNECTOR);
    const slug = (metadata.vendor as { appSlug?: unknown }).appSlug;
    if (
      typeof slug === "string" &&
      slug.length > 0 &&
      slug.length <= MAX_BOT_NAME_LENGTH
    ) {
      resolvedFromConnector = slug;
      return slug;
    }
  } catch {
    return FALLBACK_BOT_NAME;
  }
  return FALLBACK_BOT_NAME;
}

/**
 * Builds the mention matcher for a resolved bot name: `@<name>` on a word
 * boundary, the same shape the channel's built-in comment gate uses.
 *
 * @remarks
 * The name is escaped for literal matching before interpolation, and
 * {@link resolveBotName} bounds its length, so connector-supplied data can
 * never change the pattern's meaning.
 */
export function mentionPattern(botName: string): RegExp {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu");
}
