import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";

/**
 * Read-only live checks against the Vercel team that hosts customer websites.
 * The token's own permissions are not assumed: this module can only issue GET
 * requests to three fixed paths, and the project id comes from the workspace's
 * own saved record, never from the model. A project that is not in the
 * configured team is reported inaccessible and nothing about it is returned.
 * ponytail: no retries and no paging; one latest deployment and the project's
 * domain list are enough to tell "build failed" from "domain not attached".
 */

const API = "https://api.vercel.com";
const TIMEOUT_MS = 8000;
const ERROR_LIMIT = 300;
// Enough build output to name the file and the error, not the whole log.
const BUILD_ERROR_LIMIT = 1500;
const BUILD_ERROR_START = /\b(?:error|failed)\b/iu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes from build output.
const ANSI = /\u001b\[[0-9;]*m/gu;
const PROJECT_ID = /^prj_[A-Za-z0-9]{8,64}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{8,64}$/;
const TEAM_ID = /^team_[A-Za-z0-9]{8,64}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
export const LIVE_DOMAIN_LIMIT = 3;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type VercelLive =
  | {
      deployment: {
        // The failing part of the build output, when the latest build failed. The
        // customer cannot see build logs, so this is what a fix is written from.
        buildError: string | null;
        createdAt: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        state: string;
        target: string | null;
      } | null;
      domains: {
        configuration: z.infer<typeof domainConfigSchema> | null;
        assignedToProject: boolean;
        domain: string;
        misconfigured: boolean | null;
        verified: boolean | null;
      }[];
      status: "live";
    }
  // inaccessible: Vercel answered, and this project is not visible in the team.
  // unavailable: the check could not run (not configured, timeout, provider error).
  | { status: "inaccessible" | "unavailable" | "not_linked" };

const projectSchema = z.object({ accountId: z.string(), id: z.string() });
const deploymentsSchema = z.object({
  deployments: z
    .array(
      z.object({
        created: z.number().nullish(),
        errorCode: z.string().nullish(),
        errorMessage: z.string().nullish(),
        readyState: z.string().nullish(),
        state: z.string().nullish(),
        target: z.string().nullish(),
        uid: z.string().nullish(),
      })
    )
    .max(1),
});
const projectDomainsSchema = z.object({
  domains: z.array(z.object({ name: z.string(), verified: z.boolean() })),
});
// Build lines carry their text at the top level or, in other event variants, under payload.
const eventsSchema = z.array(
  z.object({
    payload: z.object({ text: z.string().nullish() }).nullish(),
    text: z.string().nullish(),
  })
);
// Vercel's getDomainConfig contract; retain the actual recommended records.
export const domainConfigSchema = z.object({
  acceptedChallenges: z
    .array(z.enum(["dns-01", "http-01"]))
    .max(2)
    .optional(),
  configuredBy: z.enum(["A", "CNAME", "dns-01", "http"]).nullable().optional(),
  misconfigured: z.boolean(),
  recommendedCNAME: z
    .array(z.object({ rank: z.number(), value: z.string().max(256) }))
    .max(10)
    .optional(),
  recommendedIPv4: z
    .array(z.object({ rank: z.number(), value: z.array(z.ipv4()).max(10) }))
    .max(10)
    .optional(),
});

/** From the first line that reports a failure to the end of the build, capped. */
export function buildErrorExcerpt(
  events: { payload?: { text?: string | null } | null; text?: string | null }[]
): string | null {
  const lines = events
    .map((event) =>
      (event.text ?? event.payload?.text ?? "").replace(ANSI, "").trimEnd()
    )
    .filter(Boolean);
  const start = lines.findIndex((line) => BUILD_ERROR_START.test(line));
  return start < 0
    ? null
    : lines.slice(start).join("\n").slice(0, BUILD_ERROR_LIMIT);
}

class Inaccessible extends Error {}

const HTTP_CODE = /^vercel_\d{3}$/u;
// Only an authored code is logged: vercel_<status>, a parse failure, or a timeout.
const failureCode = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    return "unexpected_shape";
  }
  return error instanceof Error && HTTP_CODE.test(error.message)
    ? error.message
    : "timeout_or_network";
};

// Why a live read produced no live result, without any identifier: the model
// sees only the status, so this line is the only way to tell a missing or
// under-permissioned credential from a project that is simply not in the team.
const report = (
  status: VercelLive["status"],
  code: string
): VercelLive["status"] => {
  logOpsEvent(
    "widget.support.vercel_live",
    { code, outcome: status, tool: "widget_website_status" },
    console.warn
  );
  return status;
};

type Get = <T>(path: string, schema: z.ZodType<T>) => Promise<T>;

/** The failing build's output, or null when the latest build did not fail or cannot be read. */
function readBuildError(
  latest:
    | { readyState?: string | null; state?: string | null; uid?: string | null }
    | undefined,
  get: Get
): Promise<string | null> {
  const failed = (latest?.readyState ?? latest?.state) === "ERROR";
  if (!(failed && latest?.uid && DEPLOYMENT_ID.test(latest.uid))) {
    return Promise.resolve(null);
  }
  return get(
    `/v3/deployments/${latest.uid}/events?builds=1&limit=-1`,
    eventsSchema
  )
    .then(buildErrorExcerpt)
    .catch(() => null);
}

/** Evidence for a project that already passed the team check. */
async function readProject(
  projectId: string,
  savedDomains: string[],
  get: Get
): Promise<VercelLive> {
  const domains = savedDomains
    .filter((name) => DOMAIN.test(name))
    .slice(0, LIVE_DOMAIN_LIMIT);
  const [deployments, assigned, configs] = await Promise.all([
    get(`/v6/deployments?projectId=${projectId}&limit=1`, deploymentsSchema),
    get(`/v9/projects/${projectId}/domains`, projectDomainsSchema),
    Promise.all(
      domains.map((name) =>
        get(`/v6/domains/${name}/config`, domainConfigSchema).catch(() => null)
      )
    ),
  ]);
  const [latest] = deployments.deployments;
  const buildError = await readBuildError(latest, get);
  return {
    deployment: latest
      ? {
          buildError,
          createdAt: latest.created
            ? new Date(latest.created).toISOString()
            : null,
          errorCode: latest.errorCode ?? null,
          errorMessage: latest.errorMessage?.slice(0, ERROR_LIMIT) ?? null,
          state: latest.readyState ?? latest.state ?? "unknown",
          target: latest.target ?? null,
        }
      : null,
    domains: domains.map((name, index) => {
      const match = assigned.domains.find(
        (entry) => entry.name.toLowerCase() === name.toLowerCase()
      );
      return {
        assignedToProject: Boolean(match),
        configuration: configs[index] ?? null,
        domain: name,
        misconfigured: configs[index]?.misconfigured ?? null,
        verified: match?.verified ?? null,
      };
    }),
    status: report("live", latest ? "deployment_read" : "no_deployments"),
  } as VercelLive;
}

export async function readVercelLive(
  projectId: string | null,
  savedDomains: string[],
  signal: AbortSignal,
  fetcher: Fetch = fetch,
  env: Record<string, string | undefined> = process.env
): Promise<VercelLive> {
  if (!projectId) {
    return { status: report("not_linked", "no_saved_project") } as VercelLive;
  }
  const token = env.ACQUISITY_SUPPORT_VERCEL_TOKEN;
  const teamId = env.ACQUISITY_SUPPORT_VERCEL_TEAM_ID;
  if (
    !(token && teamId && TEAM_ID.test(teamId) && PROJECT_ID.test(projectId))
  ) {
    return {
      status: report(
        "unavailable",
        token && teamId ? "invalid_reference" : "not_configured"
      ),
    } as VercelLive;
  }
  // GET is the only verb this module can send.
  const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await fetcher(
      `${API}${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}`,
      {
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      }
    );
    if (response.status === 403 || response.status === 404) {
      throw new Inaccessible(`vercel_${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`vercel_${response.status}`);
    }
    return schema.parse(await response.json());
  };
  try {
    const project = await get(`/v9/projects/${projectId}`, projectSchema);
    if (project.accountId !== teamId || project.id !== projectId) {
      return { status: report("inaccessible", "other_team") } as VercelLive;
    }
    return await readProject(projectId, savedDomains, get);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return {
      status: report(
        error instanceof Inaccessible ? "inaccessible" : "unavailable",
        failureCode(error)
      ),
    } as VercelLive;
  }
}
