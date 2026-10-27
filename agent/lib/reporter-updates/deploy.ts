import { z } from "zod";
import { DeadlineError, withDeadline } from "./deadline.js";
import { DEPLOY_REPOSITORY, type PullFacts } from "./plan.js";

export interface DeployProbe {
  isAncestor: (repo: string, base: string, head: string) => Promise<boolean>;
  liveSha: () => Promise<string | null>;
  pull: (repo: string, number: number) => Promise<PullFacts>;
}

type Fetch = typeof fetch;

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
export const SCAN_TIMEOUT_MS = 45_000;
const DEPLOYMENTS_SCANNED = 30;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const SHA = /^[0-9a-f]{7,40}$/iu;

const deploymentsSchema = z.array(
  z.object({ id: z.number().int().positive(), sha: z.string().regex(SHA) })
);
const statusesSchema = z
  .array(
    z.object({
      creator: z.object({ login: z.string() }).nullish(),
      state: z.string(),
    })
  )
  .max(10);
const VERCEL_LOGIN = "vercel[bot]";
const STATUSES_READ = 10;

type Status = z.infer<typeof statusesSchema>[number];

const isLive = (statuses: readonly Status[]): boolean => {
  const vercel = statuses.filter(
    (status) => status.creator?.login === VERCEL_LOGIN
  );
  const job = statuses.filter(
    (status) => status.creator?.login !== VERCEL_LOGIN
  );
  return (
    vercel.some((status) => status.state === "success") &&
    job.some((status) => status.state === "success") &&
    !job.some(
      (status) => status.state === "error" || status.state === "failure"
    )
  );
};
const pullSchema = z.object({
  body: z.string().nullish(),
  merge_commit_sha: z.string().regex(SHA).nullish(),
  merged: z.boolean(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
});
const compareSchema = z.object({ status: z.string() });

const read = (
  token: () => Promise<string>,
  fetchImpl: Fetch,
  path: string,
  timeoutMs: number
): Promise<unknown> =>
  withDeadline(async (signal) => {
    const response = await fetchImpl(`${API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await token()}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub read failed: HTTP ${response.status}.`);
    }
    return response.json();
  }, timeoutMs);

const scanDeployments = async (
  token: () => Promise<string>,
  fetchImpl: Fetch,
  timeoutMs: number,
  signal: AbortSignal
): Promise<string | null> => {
  const deployments = deploymentsSchema.parse(
    await read(
      token,
      fetchImpl,
      `/repos/${DEPLOY_REPOSITORY}/deployments?environment=production&per_page=${DEPLOYMENTS_SCANNED}`,
      timeoutMs
    )
  );
  const firstLive = async (index: number): Promise<string | null> => {
    const deployment = deployments[index];
    if (!deployment || signal.aborted) {
      return null;
    }
    const statuses = statusesSchema.parse(
      await read(
        token,
        fetchImpl,
        `/repos/${DEPLOY_REPOSITORY}/deployments/${deployment.id}/statuses?per_page=${STATUSES_READ}`,
        timeoutMs
      )
    );
    return isLive(statuses) ? deployment.sha : firstLive(index + 1);
  };
  return firstLive(0);
};

export const githubDeployProbe = (
  token: () => Promise<string>,
  fetchImpl: Fetch = fetch,
  timeoutMs: number = TIMEOUT_MS,
  scanTimeoutMs: number = SCAN_TIMEOUT_MS
): DeployProbe => ({
  async isAncestor(repo, base, head) {
    if (!(REPOSITORY.test(repo) && SHA.test(base) && SHA.test(head))) {
      throw new Error("Refused a malformed comparison.");
    }
    const { status } = compareSchema.parse(
      await read(
        token,
        fetchImpl,
        `/repos/${repo}/compare/${base}...${head}?per_page=1`,
        timeoutMs
      )
    );
    return status === "identical" || status === "ahead";
  },
  async liveSha() {
    const scan = (signal: AbortSignal): Promise<string | null> =>
      scanDeployments(token, fetchImpl, timeoutMs, signal);
    try {
      return await withDeadline(scan, scanTimeoutMs);
    } catch (error) {
      if (error instanceof DeadlineError && error.ms === scanTimeoutMs) {
        return null;
      }
      throw error;
    }
  },
  async pull(repo, number) {
    if (!REPOSITORY.test(repo)) {
      throw new Error("Refused a malformed repository.");
    }
    const pull = pullSchema.parse(
      await read(token, fetchImpl, `/repos/${repo}/pulls/${number}`, timeoutMs)
    );
    let state: PullFacts["state"] = "open";
    if (pull.merged) {
      state = "merged";
    } else if (pull.state === "closed") {
      state = "closed";
    }
    return {
      body: pull.body ?? "",
      mergeSha: pull.merged ? (pull.merge_commit_sha ?? null) : null,
      number,
      repo,
      state,
      title: pull.title,
    };
  },
});
