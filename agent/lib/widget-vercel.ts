import { z } from "zod";

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
const PROJECT_ID = /^prj_[A-Za-z0-9]{8,64}$/;
const TEAM_ID = /^team_[A-Za-z0-9]{8,64}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
export const LIVE_DOMAIN_LIMIT = 3;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type VercelLive =
  | {
      deployment: {
        createdAt: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        state: string;
        target: string | null;
      } | null;
      domains: {
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
      })
    )
    .max(1),
});
const projectDomainsSchema = z.object({
  domains: z.array(z.object({ name: z.string(), verified: z.boolean() })),
});
const domainConfigSchema = z.object({ misconfigured: z.boolean() });

class Inaccessible extends Error {}

export async function readVercelLive(
  projectId: string | null,
  savedDomains: string[],
  signal: AbortSignal,
  fetcher: Fetch = fetch,
  env: Record<string, string | undefined> = process.env
): Promise<VercelLive> {
  if (!projectId) {
    return { status: "not_linked" };
  }
  const token = env.ACQUISITY_SUPPORT_VERCEL_TOKEN;
  const teamId = env.ACQUISITY_SUPPORT_VERCEL_TEAM_ID;
  if (
    !(token && teamId && TEAM_ID.test(teamId) && PROJECT_ID.test(projectId))
  ) {
    return { status: "unavailable" };
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
      throw new Inaccessible();
    }
    if (!response.ok) {
      throw new Error(`vercel_${response.status}`);
    }
    return schema.parse(await response.json());
  };
  try {
    const project = await get(`/v9/projects/${projectId}`, projectSchema);
    if (project.accountId !== teamId || project.id !== projectId) {
      return { status: "inaccessible" };
    }
    const domains = savedDomains
      .filter((name) => DOMAIN.test(name))
      .slice(0, LIVE_DOMAIN_LIMIT);
    const [deployments, assigned, configs] = await Promise.all([
      get(`/v6/deployments?projectId=${projectId}&limit=1`, deploymentsSchema),
      get(`/v9/projects/${projectId}/domains`, projectDomainsSchema),
      Promise.all(
        domains.map((name) =>
          get(`/v6/domains/${name}/config`, domainConfigSchema).catch(
            () => null
          )
        )
      ),
    ]);
    const [latest] = deployments.deployments;
    return {
      deployment: latest
        ? {
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
          domain: name,
          misconfigured: configs[index]?.misconfigured ?? null,
          verified: match?.verified ?? null,
        };
      }),
      status: "live",
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return {
      status: error instanceof Inaccessible ? "inaccessible" : "unavailable",
    };
  }
}
