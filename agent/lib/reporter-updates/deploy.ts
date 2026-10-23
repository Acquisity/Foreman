import { z } from "zod";
import { DEPLOY_REPOSITORY, type PullFacts } from "./plan.js";

export interface DeployProbe {
  isAncestor: (repo: string, base: string, head: string) => Promise<boolean>;
  liveSha: () => Promise<string | null>;
  pull: (repo: string, number: number) => Promise<PullFacts>;
}

type Fetch = typeof fetch;

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const DEPLOYMENTS_SCANNED = 10;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const SHA = /^[0-9a-f]{7,40}$/iu;

const deploymentsSchema = z.array(
  z.object({ id: z.number().int().positive(), sha: z.string().regex(SHA) })
);
const statusesSchema = z.array(z.object({ state: z.string() })).max(1);
const pullSchema = z.object({
  merge_commit_sha: z.string().regex(SHA).nullish(),
  merged: z.boolean(),
  state: z.enum(["open", "closed"]),
});
const compareSchema = z.object({ status: z.string() });

const read = async (
  token: () => Promise<string>,
  fetchImpl: Fetch,
  path: string
): Promise<unknown> => {
  const response = await fetchImpl(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await token()}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub read failed: HTTP ${response.status}.`);
  }
  return response.json();
};

export const githubDeployProbe = (
  token: () => Promise<string>,
  fetchImpl: Fetch = fetch
): DeployProbe => ({
  async isAncestor(repo, base, head) {
    if (!(REPOSITORY.test(repo) && SHA.test(base) && SHA.test(head))) {
      throw new Error("Refused a malformed comparison.");
    }
    const { status } = compareSchema.parse(
      await read(
        token,
        fetchImpl,
        `/repos/${repo}/compare/${base}...${head}?per_page=1`
      )
    );
    return status === "identical" || status === "ahead";
  },
  async liveSha() {
    const deployments = deploymentsSchema.parse(
      await read(
        token,
        fetchImpl,
        `/repos/${DEPLOY_REPOSITORY}/deployments?environment=production&per_page=${DEPLOYMENTS_SCANNED}`
      )
    );
    const latest = await Promise.all(
      deployments.map(async ({ id }) => {
        const [status] = statusesSchema.parse(
          await read(
            token,
            fetchImpl,
            `/repos/${DEPLOY_REPOSITORY}/deployments/${id}/statuses?per_page=1`
          )
        );
        return status?.state ?? null;
      })
    );
    const index = latest.indexOf("success");
    return index === -1 ? null : (deployments[index]?.sha ?? null);
  },
  async pull(repo, number) {
    if (!REPOSITORY.test(repo)) {
      throw new Error("Refused a malformed repository.");
    }
    const pull = pullSchema.parse(
      await read(token, fetchImpl, `/repos/${repo}/pulls/${number}`)
    );
    let state: PullFacts["state"] = "open";
    if (pull.merged) {
      state = "merged";
    } else if (pull.state === "closed") {
      state = "closed";
    }
    return {
      mergeSha: pull.merged ? (pull.merge_commit_sha ?? null) : null,
      number,
      repo,
      state,
    };
  },
});
