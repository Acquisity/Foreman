import type { RegressionKind, RegressionRecord } from "./regression-record.js";

/**
 * The regression lane (ENG-16056): before Foreman blames code for a bug, find
 * out whether the last 30 days of history on that code already fixed it, and
 * whether production runs that fix. Git facts come from an injected shell, so
 * the tests run real git in a temp directory and the tool runs the sandbox.
 */
export const HISTORY_DAYS = 30;
export const MAX_CANDIDATES = 25;
const MAX_PATCH_CHARS = 3000;
const MAX_TIMELINE = 50;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DAY_MS = 86_400_000;
const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

export interface ShellResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}
export type Shell = (command: string) => Promise<ShellResult>;

export interface Candidate {
  date: string;
  patch: string;
  sha: string;
  subject: string;
}

export type Role = "fixed" | "introduced" | "neither";
export interface Label {
  role: Role;
  sha: string;
}

export interface Deployment {
  commit: string;
  readyAt: string;
}

/**
 * `current` is the deployment production serves right now, so a rollback shows
 * as an older commit. `timeline` is only used to tell what ran at the failure
 * time, newest first.
 */
export interface DeploymentEvidence {
  current: Deployment | null;
  timeline: Deployment[];
}

export type FailureTimeSource = "claim" | "ticket-created";

export interface Blame {
  file: string;
  lines?: { end: number; start: number };
  needle?: string;
}

export interface Failure {
  ok: false;
  reason: string;
}

export interface Resolution {
  commit?: string;
  kind: RegressionKind;
  line: string;
  reason?: string;
}

export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const isSha = (value: string) => SHA_PATTERN.test(value);

const FORBIDDEN_TEXT = /[\0\n\r]/u;

/** Why a blamed file or string can't be put on a command line, or null. */
export const blameProblem = (blame: Blame): string | null => {
  if (
    !blame.file ||
    blame.file.startsWith("-") ||
    blame.file.startsWith("/") ||
    blame.file.split("/").includes("..") ||
    FORBIDDEN_TEXT.test(blame.file) ||
    blame.file.length > 300
  ) {
    return "The file must be a repository-relative path.";
  }
  if (Boolean(blame.lines) === Boolean(blame.needle)) {
    return "Pass either the blamed line range or a distinctive string, not both and not neither.";
  }
  if (
    blame.needle &&
    (FORBIDDEN_TEXT.test(blame.needle) || blame.needle.length > 200)
  ) {
    return "The string must be one line of at most 200 characters.";
  }
  if (
    blame.lines &&
    !(
      Number.isInteger(blame.lines.start) &&
      Number.isInteger(blame.lines.end) &&
      blame.lines.start >= 1 &&
      blame.lines.end >= blame.lines.start
    )
  ) {
    return "The line range must be whole numbers with start at least 1 and end at least start.";
  }
  return null;
};

export const sinceIso = (now: Date, days = HISTORY_DAYS) =>
  new Date(now.getTime() - days * DAY_MS).toISOString();

const git = (worktree: string, args: string) =>
  `git -C ${quote(worktree)} ${args}`;

const trimmed = (result: ShellResult) => String(result.stdout).trim();

const failure = (what: string, result: ShellResult): Failure => ({
  ok: false,
  reason: `${what} (exit ${result.exitCode}): ${String(
    result.stderr || result.stdout
  )
    .trim()
    .slice(0, 300)}`,
});

const hasCommit = async (shell: Shell, worktree: string, sha: string) =>
  (await shell(git(worktree, `cat-file -e ${sha}^{commit}`))).exitCode === 0;

/**
 * Makes sure every commit dated inside the window and reachable from the
 * commit read is present, deepening a shallow clone. A repo that is not
 * shallow already has it. Complete means the fetch exited 0 and the commit
 * resolves; anything else is a failure, so a thin clone can never read as
 * "nothing changed".
 *
 * Deployment commits missing locally are fetched too (window first, then the
 * single commit). A commit that still isn't there is not a commit of this
 * repository, and the caller treats it as unknown.
 */
export async function ensureHistory(
  shell: Shell,
  options: {
    deploymentCommits: string[];
    readCommit: string;
    remote: string;
    since: string;
    worktree: string;
  }
): Promise<{ ok: true } | Failure> {
  const { worktree } = options;
  const inside = await shell(
    `test "$(${git(worktree, "rev-parse --show-toplevel")})" = "$(cd ${quote(worktree)} && pwd -P)"`
  );
  if (inside.exitCode !== 0) {
    return {
      ok: false,
      reason: "This workspace holds no git history to check.",
    };
  }
  const shallow = await shell(
    git(worktree, "rev-parse --is-shallow-repository")
  );
  if (shallow.exitCode !== 0) {
    return failure("Could not tell whether the clone is shallow", shallow);
  }
  const isShallow = trimmed(shallow) === "true";
  const fetchSince = (sha: string) =>
    shell(
      git(
        worktree,
        `fetch --quiet --shallow-since=${quote(options.since)} ${quote(options.remote)} ${sha}`
      )
    );
  if (isShallow) {
    const fetched = await fetchSince(options.readCommit);
    if (fetched.exitCode !== 0) {
      return failure(
        "Could not fetch 30 days of history for the commit read",
        fetched
      );
    }
  }
  if (!(await hasCommit(shell, worktree, options.readCommit))) {
    return {
      ok: false,
      reason: "The commit read is not in this checkout's history.",
    };
  }
  for (const commit of options.deploymentCommits) {
    // biome-ignore lint/performance/noAwaitInLoops: fetches in one repository take its shallow lock, so they run one at a time.
    if (await hasCommit(shell, worktree, commit)) {
      continue;
    }
    const windowed = await fetchSince(commit);
    if (windowed.exitCode !== 0) {
      await shell(
        git(
          worktree,
          `fetch --quiet --depth=1 ${quote(options.remote)} ${commit}`
        )
      );
    }
  }
  return { ok: true };
}

const parseCandidates = (stdout: string) =>
  stdout
    .split(RECORD_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", date = "", ...subject] = entry.split(FIELD_SEPARATOR);
      return { date, sha, subject: subject.join(FIELD_SEPARATOR).trim() };
    })
    .filter((candidate) => isSha(candidate.sha));

/**
 * The commits from the window that touched the blamed lines (an explicit
 * range, because `-L :name:file` latches onto an `import { name }` line in
 * TypeScript) or the blamed string, newest first by topology, each with a
 * bounded patch. More than {@link MAX_CANDIDATES} is refused: every candidate
 * has to be labelled, so a range that busy needs narrowing.
 */
export async function listCandidates(
  shell: Shell,
  options: Blame & { readCommit: string; since: string; worktree: string }
): Promise<{ candidates: Candidate[]; ok: true } | Failure> {
  const { worktree, readCommit, since } = options;
  const format = `--format=${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s`;
  const base = `log --topo-order --since=${quote(since)} ${format}`;
  const file = quote(options.file);
  const selector = options.lines
    ? `-L${options.lines.start},${options.lines.end}:${file} -s ${readCommit}`
    : `-S${quote(options.needle ?? "")} ${readCommit} -- ${file}`;
  const listed = await shell(git(worktree, `${base} ${selector}`));
  if (listed.exitCode !== 0) {
    return failure("Could not read the history of the blamed code", listed);
  }
  const found = parseCandidates(String(listed.stdout));
  if (found.length > MAX_CANDIDATES) {
    return {
      ok: false,
      reason: `More than ${MAX_CANDIDATES} commits touched it in 30 days; narrow the line range or the string.`,
    };
  }
  const candidates = await Promise.all(
    found.map(async (entry): Promise<Candidate> => {
      const patchCommand = options.lines
        ? `log -L${options.lines.start},${options.lines.end}:${file} -n1 --format= ${entry.sha}`
        : `show --format= ${entry.sha} -- ${file}`;
      const patch = await shell(git(worktree, patchCommand));
      return {
        ...entry,
        patch:
          patch.exitCode === 0
            ? String(patch.stdout).trim().slice(0, MAX_PATCH_CHARS)
            : "(patch unavailable)",
      };
    })
  );
  return { candidates, ok: true };
}

/** true or false from git, null when git could not answer. */
const contains = async (
  shell: Shell,
  worktree: string,
  ancestor: string,
  descendant: string
): Promise<boolean | null> => {
  const result = await shell(
    git(worktree, `merge-base --is-ancestor ${ancestor} ${descendant}`)
  );
  if (result.exitCode === 0) {
    return true;
  }
  return result.exitCode === 1 ? false : null;
};

export const lineFor = (
  kind: RegressionKind,
  commit?: string,
  reason?: string
): string => {
  switch (kind) {
    case "introduced":
      return `introduced by ${commit}`;
    case "fixed_live":
      return `fixed on main and live, by ${commit}`;
    case "fixed_not_deployed":
      return `fixed on main, not deployed yet, by ${commit}`;
    case "fixed_deploy_unknown":
      return `fixed on main, deploy status unknown, by ${commit}`;
    case "none":
      return "none";
    default:
      return `unchecked: ${reason}`;
  }
};

const resolution = (
  kind: RegressionKind,
  commit?: string,
  reason?: string
): Resolution => ({
  ...(commit ? { commit } : {}),
  kind,
  line: lineFor(kind, commit, reason),
  ...(reason ? { reason } : {}),
});

const unchecked = (reason: string): Resolution =>
  resolution("unchecked", undefined, reason);

/** Why the labels don't cover the candidates exactly, or null. */
export const labelProblem = (
  candidates: Candidate[],
  labels: Label[]
): string | null => {
  const known = new Set(candidates.map((candidate) => candidate.sha));
  const labelled = new Set(labels.map((label) => label.sha));
  const missing = candidates.filter(
    (candidate) => !labelled.has(candidate.sha)
  );
  if (missing.length > 0) {
    return `Label every commit; these have no label: ${missing.map((candidate) => candidate.sha).join(", ")}.`;
  }
  const stray = labels.filter((label) => !known.has(label.sha));
  if (stray.length > 0) {
    return `These labels name commits that did not touch the blamed code in the window: ${stray.map((label) => label.sha).join(", ")}.`;
  }
  return labelled.size === labels.length
    ? null
    : "Each commit takes exactly one label.";
};

const byReadyAtDescending = (a: Deployment, b: Deployment) =>
  Date.parse(b.readyAt) - Date.parse(a.readyAt);

/**
 * Turns labels into the result. The latest labelled commit that isn't
 * `neither` decides, so a fix followed by a revert is `introduced`.
 *
 * Production state comes from `current` alone, so a fix that shipped and was
 * rolled back reads as not deployed. The timeline only answers what ran at the
 * failure time: a fix that was already live then did not fix this failure, and
 * a timeline that doesn't reach back to it can't say.
 */
export async function resolveRegression(
  shell: Shell,
  options: {
    candidates: Candidate[];
    deployments: DeploymentEvidence;
    failureAt: string;
    failureAtSource: FailureTimeSource;
    labels: Label[];
    worktree: string;
  }
): Promise<Resolution> {
  const { candidates, worktree, deployments } = options;
  const decisive = candidates
    .map((candidate) => ({
      candidate,
      role: options.labels.find((label) => label.sha === candidate.sha)?.role,
    }))
    .find((entry) => entry.role && entry.role !== "neither");
  if (!decisive) {
    return resolution("none");
  }
  const { sha } = decisive.candidate;
  const { current } = deployments;
  if (decisive.role === "introduced") {
    if (
      current &&
      (await contains(shell, worktree, sha, current.commit)) === false
    ) {
      return unchecked(
        "the introducing commit is not in the commit production serves, so production cannot show a bug from it"
      );
    }
    return resolution("introduced", sha);
  }
  if (!current) {
    return resolution("fixed_deploy_unknown", sha);
  }
  const live = await contains(shell, worktree, sha, current.commit);
  if (live === null) {
    return unchecked("git could not compare the fix with production's commit");
  }
  if (!live) {
    return resolution("fixed_not_deployed", sha);
  }
  const failureAt = Date.parse(options.failureAt);
  const unknownTime =
    options.failureAtSource === "claim"
      ? ""
      : "; the failure time is not known, only that the ticket was created at that point";
  const liveThen = [...deployments.timeline]
    .sort(byReadyAtDescending)
    .find((deployment) => Date.parse(deployment.readyAt) <= failureAt);
  if (!liveThen) {
    return unchecked(
      `the deployment history does not reach back to the failure time${unknownTime}`
    );
  }
  const alreadyLive = await contains(shell, worktree, sha, liveThen.commit);
  if (alreadyLive === null) {
    return unchecked(
      `git could not compare the fix with the deployment live at the failure time${unknownTime}`
    );
  }
  return alreadyLive
    ? unchecked(
        `the fix was already live at the failure time${unknownTime}, so it does not explain this failure`
      )
    : resolution("fixed_live", sha);
}

export interface CheckInput extends Blame {
  deployments: DeploymentEvidence;
  failureAt: string;
  failureAtSource: FailureTimeSource;
  issue: string;
  labels?: Label[];
  readCommit: string;
}

export interface CheckDeps {
  closeNetwork: () => Promise<void>;
  now: () => Date;
  openNetwork: () => Promise<void>;
  remote: string;
  shell: Shell;
  worktree: string;
}

export type CheckResult =
  | { candidates: Candidate[]; status: "labels_needed" }
  | { error: string; status: "error" }
  | { candidates: Candidate[]; record: RegressionRecord; status: "recorded" };

/** What is wrong with the input before any command runs, or null. */
export const inputProblem = (input: CheckInput): string | null => {
  const deployments = [
    ...(input.deployments.current ? [input.deployments.current] : []),
    ...input.deployments.timeline,
  ];
  if (!isSha(input.readCommit)) {
    return "readCommit must be a full 40-character commit.";
  }
  if (
    deployments.some(
      (deployment) =>
        !(
          isSha(deployment.commit) &&
          Number.isFinite(Date.parse(deployment.readyAt))
        )
    )
  ) {
    return "Every deployment needs a 40-character commit and an ISO readyAt time.";
  }
  if (input.deployments.timeline.length > MAX_TIMELINE) {
    return `Pass at most ${MAX_TIMELINE} timeline deployments.`;
  }
  if (!Number.isFinite(Date.parse(input.failureAt))) {
    return "failureAt must be an ISO time.";
  }
  return blameProblem(input);
};

/**
 * One check: deepen the history, list what touched the blamed code, and, once
 * the caller has labelled every candidate, resolve the result. Anything the
 * environment gets wrong (no git, a failed fetch, an unreadable log) is an
 * `unchecked` record, never `none`.
 */
export async function runCheckRegression(
  deps: CheckDeps,
  input: CheckInput
): Promise<CheckResult> {
  const problem = inputProblem(input);
  if (problem) {
    return { error: problem, status: "error" };
  }
  const since = sinceIso(deps.now());
  const recordOf = (
    outcome: Resolution,
    deployed: string | null
  ): RegressionRecord => ({
    ...outcome,
    commitRead: input.readCommit,
    deployedCommit: deployed,
    issue: input.issue,
    windowDays: HISTORY_DAYS,
  });
  const unusable = (reason: string): CheckResult => ({
    candidates: [],
    record: recordOf(unchecked(reason), null),
    status: "recorded",
  });

  const asked = [
    ...(input.deployments.current ? [input.deployments.current] : []),
    ...input.deployments.timeline,
  ].map((deployment) => deployment.commit);
  let ensured: { ok: true } | Failure;
  await deps.openNetwork();
  try {
    ensured = await ensureHistory(deps.shell, {
      deploymentCommits: [...new Set(asked)],
      readCommit: input.readCommit,
      remote: deps.remote,
      since,
      worktree: deps.worktree,
    });
  } finally {
    await deps.closeNetwork();
  }
  if (!ensured.ok) {
    return unusable(ensured.reason);
  }

  const listed = await listCandidates(deps.shell, {
    ...input,
    since,
    worktree: deps.worktree,
  });
  if (!listed.ok) {
    return unusable(listed.reason);
  }

  const present = async (deployment: Deployment | null) =>
    deployment &&
    (await hasCommit(deps.shell, deps.worktree, deployment.commit))
      ? deployment
      : null;
  const current = await present(input.deployments.current);
  const checked = await Promise.all(
    input.deployments.timeline.map((deployment) => present(deployment))
  );
  const timeline = checked.filter(
    (deployment): deployment is Deployment => deployment !== null
  );
  const timelineComplete = timeline.length === checked.length;
  // A timeline with a deployment that isn't a commit of this repository can't
  // say what ran at the failure time: dropping the entry would pick an older
  // deployment as the one that was live.
  const evidence: DeploymentEvidence = {
    current,
    timeline: timelineComplete ? timeline : [],
  };
  const deployedCommit = current?.commit ?? null;

  if (listed.candidates.length === 0) {
    return {
      candidates: [],
      record: recordOf(resolution("none"), deployedCommit),
      status: "recorded",
    };
  }
  if (!input.labels) {
    return { candidates: listed.candidates, status: "labels_needed" };
  }
  const bad = labelProblem(listed.candidates, input.labels);
  if (bad) {
    return { error: bad, status: "error" };
  }
  const resolved = await resolveRegression(deps.shell, {
    candidates: listed.candidates,
    deployments: evidence,
    failureAt: input.failureAt,
    failureAtSource: input.failureAtSource,
    labels: input.labels,
    worktree: deps.worktree,
  });
  return {
    candidates: listed.candidates,
    record: recordOf(resolved, deployedCommit),
    status: "recorded",
  };
}

/** A record for a workspace that cannot be checked at all (a replay archive). */
export const uncheckedRecord = (
  issue: string,
  readCommit: string,
  reason: string
): RegressionRecord => ({
  ...unchecked(reason),
  commitRead: readCommit,
  deployedCommit: null,
  issue,
  windowDays: HISTORY_DAYS,
});
