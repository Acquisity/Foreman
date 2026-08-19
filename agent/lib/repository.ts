import { createHash } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";

export const REPOSITORY_ATTRIBUTE = "repository";
export const REPOSITORY_SOURCE_ATTRIBUTE = "repositorySource";
export const REPOSITORY_MARKER = "/workspace/.foreman/repository.json";

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL_PATTERN =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=$|[\s/#?.,!)\]}])/giu;
const SLUG_PATTERN =
  /(?<![A-Za-z0-9._/-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100})(?![A-Za-z0-9._/-])/gu;
const GIT_SUFFIX_PATTERN = /\.git$/u;

export interface RepositoryTarget {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
}

export interface PreparedRepository extends RepositoryTarget {
  readonly source: "explicit" | "github-webhook";
  readonly worktree: "/workspace" | "/workspace/repo";
}

export const parseRepository = (value: string): RepositoryTarget | null => {
  const normalized = value.trim().replace(GIT_SUFFIX_PATTERN, "");
  if (!REPOSITORY_PATTERN.test(normalized)) {
    return null;
  }
  const [owner, repo] = normalized.split("/");
  if (!(owner && repo) || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo, slug: `${owner}/${repo}` };
};

export const extractRepositories = (text: string): RepositoryTarget[] => {
  const repositories = new Map<string, RepositoryTarget>();
  const bounded = text.slice(0, 100_000);
  for (const match of bounded.matchAll(GITHUB_URL_PATTERN)) {
    const parsed = parseRepository(`${match[1]}/${match[2]}`);
    if (parsed) {
      repositories.set(parsed.slug.toLowerCase(), parsed);
    }
  }
  for (const match of bounded.matchAll(SLUG_PATTERN)) {
    const parsed = parseRepository(match[1] ?? "");
    if (parsed) {
      repositories.set(parsed.slug.toLowerCase(), parsed);
    }
  }
  return [...repositories.values()];
};

export const stampRepository = (
  auth: SessionAuthContext,
  repository: string,
  source: "explicit" | "github-webhook"
): SessionAuthContext => {
  const parsed = parseRepository(repository);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository '${repository}'.`);
  }
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [REPOSITORY_ATTRIBUTE]: parsed.slug,
      [REPOSITORY_SOURCE_ATTRIBUTE]: source,
    },
  };
};

export const repositoryFromAuth = (
  auth: SessionAuthContext | null
): (RepositoryTarget & { source: "explicit" | "github-webhook" }) | null => {
  const repository = auth?.attributes[REPOSITORY_ATTRIBUTE];
  const source = auth?.attributes[REPOSITORY_SOURCE_ATTRIBUTE];
  if (typeof repository !== "string") {
    return null;
  }
  const parsed = parseRepository(repository);
  if (!parsed || (source !== "explicit" && source !== "github-webhook")) {
    return null;
  }
  return { ...parsed, source };
};

export const resolveRepository = (
  requested: string | undefined,
  auth: SessionAuthContext | null
): RepositoryTarget & { source: "explicit" | "github-webhook" } => {
  const authoritative = repositoryFromAuth(auth);
  const parsedRequested = requested ? parseRepository(requested) : null;
  if (requested && !parsedRequested) {
    throw new Error("Repository must be an explicit GitHub owner/repo slug.");
  }
  if (authoritative?.source === "github-webhook") {
    if (
      parsedRequested &&
      parsedRequested.slug.toLowerCase() !== authoritative.slug.toLowerCase()
    ) {
      throw new Error(
        `This signed GitHub session is bound to ${authoritative.slug}; message text cannot retarget it to ${parsedRequested.slug}.`
      );
    }
    return authoritative;
  }
  if (authoritative && !parsedRequested) {
    return authoritative;
  }
  if (parsedRequested) {
    return { ...parsedRequested, source: "explicit" };
  }
  throw new Error(
    "No repository is selected. Provide one explicit owner/repo slug or GitHub URL."
  );
};

export const resolveRepositoryInput = (
  input: string,
  auth: SessionAuthContext | null
): RepositoryTarget & { source: "explicit" | "github-webhook" } => {
  const extracted = extractRepositories(input);
  if (extracted.length > 1) {
    throw new Error(
      "Repository selection is ambiguous. Provide exactly one GitHub owner/repo slug or URL."
    );
  }
  return resolveRepository(extracted[0]?.slug, auth);
};

export const repositoryHash = (repository: string): string => {
  const parsed = parseRepository(repository);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository '${repository}'.`);
  }
  return createHash("sha256").update(parsed.slug.toLowerCase()).digest("hex");
};

export const remoteUrl = (repository: string): string => {
  const parsed = parseRepository(repository);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository '${repository}'.`);
  }
  return `https://github.com/${parsed.slug}.git`;
};

export const readPreparedRepository = async (
  sandbox: SandboxSession
): Promise<PreparedRepository> => {
  const raw = await sandbox.readTextFile({ path: REPOSITORY_MARKER });
  if (raw === null) {
    throw new Error("No repository has been prepared.");
  }
  const marker = (JSON.parse(raw) ?? {}) as Partial<PreparedRepository>;
  const repository = parseRepository(
    typeof marker.slug === "string" ? marker.slug : ""
  );
  if (
    !repository ||
    (marker.source !== "explicit" && marker.source !== "github-webhook") ||
    (marker.worktree !== "/workspace" && marker.worktree !== "/workspace/repo")
  ) {
    throw new Error("The prepared repository marker is invalid.");
  }
  return { ...repository, source: marker.source, worktree: marker.worktree };
};
