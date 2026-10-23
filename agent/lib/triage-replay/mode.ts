import type { SessionAuthContext } from "eve/context";

/**
 * Triage replay (ENG-16049): with TRIAGE_REPLAY=1 the whole server process
 * replays settled ENG tickets through today's triage code. Every Linear
 * operation answers from a simulated store, every other provider read fails
 * closed, and outbound HTTP is limited to the model and storage hosts. A
 * replay process never runs next to production, the widget replay or live
 * modes, investigation memory, or a warm sandbox snapshot, whose checkouts
 * and Git objects hold code newer than the case.
 */

/** Auth attribute naming the replayed case on the session and its subagents. */
export const TRIAGE_REPLAY_CASE_ATTRIBUTE = "triageReplayCase";
/** Auth attribute naming the approved replay run. */
export const TRIAGE_REPLAY_RUN_ATTRIBUTE = "triageReplayRun";

export const isTriageReplay = (env: NodeJS.ProcessEnv = process.env) =>
  env.TRIAGE_REPLAY === "1";

/** Throws when replay is combined with anything that could reach real state or future code. */
export function assertTriageReplayAllowed(
  env: NodeJS.ProcessEnv = process.env
) {
  if (!isTriageReplay(env)) {
    return;
  }
  const conflicts = [
    env.VERCEL_ENV === "production" && "VERCEL_ENV=production",
    (env.WIDGET_REPLAY === "1" || Boolean(env.WIDGET_REPLAY_CASE)) &&
      "widget replay",
    env.WIDGET_LIVE === "1" && "widget live",
    Boolean(env.FOREMAN_MEMORY_DATABASE_URL) && "FOREMAN_MEMORY_DATABASE_URL",
    Boolean(env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID) &&
      "VERCEL_SANDBOX_BASE_SNAPSHOT_ID",
  ].filter(Boolean);
  if (conflicts.length > 0) {
    throw new Error(`Triage replay cannot run with ${conflicts.join(", ")}.`);
  }
}

/** The replayed case and run a session belongs to, or null outside a replay session. */
export function replaySessionOf(
  auth: SessionAuthContext | null | undefined
): { caseId: string; runId: string } | null {
  if (!(isTriageReplay() && auth)) {
    return null;
  }
  const caseId = auth.attributes[TRIAGE_REPLAY_CASE_ATTRIBUTE];
  const runId = auth.attributes[TRIAGE_REPLAY_RUN_ATTRIBUTE];
  return typeof caseId === "string" && typeof runId === "string"
    ? { caseId, runId }
    : null;
}

/** Hosts a replay process may reach: models and the Blob store holding replay state and archives. */
export function replayAllowedHosts(
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const hosts = new Set(["ai-gateway.vercel.sh"]);
  for (const url of [env.CLIPROXY_BASE_URL]) {
    if (url) {
      hosts.add(new URL(url).host);
    }
  }
  for (const host of (env.TRIAGE_REPLAY_ALLOWED_HOSTS ?? "").split(",")) {
    if (host.trim()) {
      hosts.add(host.trim());
    }
  }
  return hosts;
}

/**
 * Platform endpoints a replay needs beyond the models: Blob (replay state and
 * repository archives), the Vercel Sandbox control plane, and OIDC refresh.
 * Paths are pinned so the same hosts can't serve runtime logs or other APIs.
 */
const isPlatformRequest = (url: URL) =>
  url.host.endsWith(".blob.vercel-storage.com") ||
  (url.host === "vercel.com" && url.pathname.startsWith("/api/blob")) ||
  (url.host === "api.vercel.com" && url.pathname.includes("/sandboxes")) ||
  url.host.endsWith(".vercel.run") ||
  url.host === "oidc.vercel.com";

/** Raised for any outbound request a replay process may not make. */
export class ReplayEgressError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`Triage replay blocks outbound requests to ${host}.`);
    this.name = "ReplayEgressError";
    this.host = host;
  }
}

let installed = false;

/**
 * Wraps the global fetch so a replay process reaches only the allowed hosts.
 * Every provider, Linear, GitHub, Slack or help-center call fails closed.
 */
export function installReplayEgressGuard(
  env: NodeJS.ProcessEnv = process.env,
  target: { fetch: typeof fetch } = globalThis
) {
  if (!isTriageReplay(env) || (installed && target === globalThis)) {
    return;
  }
  const allowed = replayAllowedHosts(env);
  const original = target.fetch.bind(target);
  target.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (!(allowed.has(url.host) || isPlatformRequest(url))) {
      return Promise.reject(new ReplayEgressError(url.host));
    }
    return original(input, init);
  }) as typeof fetch;
  if (target === globalThis) {
    installed = true;
  }
}

assertTriageReplayAllowed();
installReplayEgressGuard();
