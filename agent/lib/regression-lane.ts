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
const DEEPEN_ROUNDS = 3;
const DEEPEN_BY = 200;
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

/** Production's deployed commit and ancestry, read from GitHub (the reporter-updates probe). */
export interface DeployReads {
  isAncestor: (base: string, head: string) => Promise<boolean>;
  liveSha: () => Promise<string | null>;
}

export type FailureTimeSource = "claim" | "ticket-created";

export interface Blame {
  file: string;
  lines: { end: number; start: number };
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

/** Why a blamed file or range can't be put on a command line, or null. */
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
  if (
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

/**
 * The in-window commits reachable from the commit read that are shallow
 * boundaries: their parents are missing, so `git log -L` would treat each as
 * the root that added every blamed line.
 */
const windowBoundaries = async (
  shell: Shell,
  worktree: string,
  readCommit: string,
  since: string
): Promise<string[] | Failure> => {
  const path = await shell(git(worktree, "rev-parse --git-path shallow"));
  if (path.exitCode !== 0) {
    return failure("Could not find the clone's shallow list", path);
  }
  const listed = await shell(
    `cat ${quote(`${worktree}/${trimmed(path)}`)} 2>/dev/null || true`
  );
  const boundaries = new Set(trimmed(listed).split("\n").filter(Boolean));
  if (boundaries.size === 0) {
    return [];
  }
  const inWindow = await shell(
    git(worktree, `rev-list --since=${quote(since)} ${readCommit}`)
  );
  if (inWindow.exitCode !== 0) {
    return failure("Could not list the window's commits", inWindow);
  }
  return trimmed(inWindow)
    .split("\n")
    .filter((sha) => boundaries.has(sha));
};

/**
 * Makes the history of the commit read complete for the window, and proves
 * it: no commit dated inside the window may be a shallow boundary. A shallow
 * clone is fetched back past the window, then deepened a bounded number of
 * times; anything still unproven is a failure, so a thin clone can never
 * invent an introducing commit or read as "nothing changed".
 */
export async function ensureHistory(
  shell: Shell,
  options: {
    readCommit: string;
    remote: string;
    since: string;
    worktree: string;
  }
): Promise<{ ok: true } | Failure> {
  const { readCommit, remote, since, worktree } = options;
  const inside = await shell(
    `test "$(${git(worktree, "rev-parse --show-toplevel")})" = "$(cd ${quote(worktree)} && pwd -P)"`
  );
  if (inside.exitCode !== 0) {
    return {
      ok: false,
      reason: "This workspace holds no git history to check.",
    };
  }
  const margin = new Date(Date.parse(since) - DAY_MS).toISOString();
  const fetched = await shell(
    git(
      worktree,
      `fetch --quiet --shallow-since=${quote(margin)} ${quote(remote)} ${readCommit}`
    )
  );
  const shallow = await shell(
    git(worktree, "rev-parse --is-shallow-repository")
  );
  if (shallow.exitCode !== 0) {
    return failure("Could not tell whether the clone is shallow", shallow);
  }
  if (trimmed(shallow) === "true" && fetched.exitCode !== 0) {
    return failure(
      "Could not fetch 30 days of history for the commit read",
      fetched
    );
  }
  for (let round = 0; round <= DEEPEN_ROUNDS; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round depends on what the last fetch left.
    const open = await windowBoundaries(shell, worktree, readCommit, since);
    if (!Array.isArray(open)) {
      return open;
    }
    if (open.length === 0) {
      return { ok: true };
    }
    if (round === DEEPEN_ROUNDS) {
      break;
    }
    const deepened = await shell(
      git(
        worktree,
        `fetch --quiet --deepen=${DEEPEN_BY} ${quote(remote)} ${readCommit}`
      )
    );
    if (deepened.exitCode !== 0) {
      return failure("Could not deepen the history to cover 30 days", deepened);
    }
  }
  return {
    ok: false,
    reason:
      "Could not prove the last 30 days of history are complete in this clone.",
  };
}

/**
 * The commits from the window that touched the blamed lines, newest first by
 * topology, each with its patch. `git log -L` tracks the range back through
 * every revision itself, so each patch shows the lines as they were in that
 * commit. A merge whose resolution git can't show for the range comes back
 * with an empty patch: it is never offered for a label, and if it is newer
 * than the decisive commit the result is unchecked. More than
 * {@link MAX_CANDIDATES} is refused: every candidate has to be labelled, so a
 * range that busy needs narrowing.
 */
export async function listCandidates(
  shell: Shell,
  options: Blame & { readCommit: string; since: string; worktree: string }
): Promise<{ candidates: Candidate[]; ok: true } | Failure> {
  const { worktree, readCommit, since } = options;
  const format = `--format=${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s`;
  const range = `-L${options.lines.start},${options.lines.end}:${quote(options.file)}`;
  const listed = await shell(
    git(
      worktree,
      `log --topo-order --no-color --since=${quote(since)} ${format} ${range} ${readCommit}`
    )
  );
  if (listed.exitCode !== 0) {
    return failure("Could not read the history of the blamed code", listed);
  }
  const candidates = String(listed.stdout)
    .split(RECORD_SEPARATOR)
    .filter((entry) => entry.trim())
    .map((entry) => {
      const newline = entry.indexOf("\n");
      const header = newline === -1 ? entry : entry.slice(0, newline);
      const [sha = "", date = "", ...subject] = header.split(FIELD_SEPARATOR);
      return {
        date,
        patch: (newline === -1 ? "" : entry.slice(newline + 1))
          .trim()
          .slice(0, MAX_PATCH_CHARS),
        sha: sha.trim(),
        subject: subject.join(FIELD_SEPARATOR).trim(),
      };
    })
    .filter((candidate) => isSha(candidate.sha));
  if (candidates.length > MAX_CANDIDATES) {
    return {
      ok: false,
      reason: `More than ${MAX_CANDIDATES} commits touched it in 30 days; narrow the line range.`,
    };
  }
  return { candidates, ok: true };
}

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

const ancestry = (reads: DeployReads, base: string, head: string) =>
  reads.isAncestor(base, head).then(
    (contained) => contained,
    () => null
  );

/**
 * Turns labels into the result. The latest labelled commit that isn't
 * `neither` decides, so a fix followed by a revert is `introduced`.
 *
 * Production state is only what production serves now. Whether a fix was
 * already live when the customer hit the failure is out of scope, so a fix
 * committed on or before the failure time is unchecked: it can't be shown to
 * have fixed this failure.
 */
export async function resolveRegression(options: {
  candidates: Candidate[];
  failureAt: string;
  failureAtSource: FailureTimeSource;
  labels: Label[];
  live: string | null;
  reads: DeployReads;
}): Promise<Resolution> {
  const { candidates, live, reads } = options;
  const decisive = candidates
    .map((candidate) => ({
      candidate,
      role: candidate.patch
        ? options.labels.find((label) => label.sha === candidate.sha)?.role
        : "unavailable",
    }))
    .find((entry) => entry.role && entry.role !== "neither");
  if (!decisive) {
    return resolution("none");
  }
  if (decisive.role === "unavailable") {
    return unchecked(
      `merge ${decisive.candidate.sha} changed the blamed lines but git shows no patch for it, so its effect cannot be labelled`
    );
  }
  const { date, sha } = decisive.candidate;
  if (decisive.role === "introduced") {
    if (live && (await ancestry(reads, sha, live)) === false) {
      return unchecked(
        "the introducing commit is not in the commit production serves, so production cannot show a bug from it"
      );
    }
    return resolution("introduced", sha);
  }
  if (Date.parse(date) <= Date.parse(options.failureAt)) {
    const when =
      options.failureAtSource === "claim"
        ? "the failure time"
        : "the ticket's creation (the failure time is not known)";
    return unchecked(
      `the fix was on main before ${when}, so it cannot be shown to fix this failure`
    );
  }
  if (!live) {
    return resolution("fixed_deploy_unknown", sha);
  }
  const contained = await ancestry(reads, sha, live);
  if (contained === null) {
    return resolution("fixed_deploy_unknown", sha);
  }
  return resolution(contained ? "fixed_live" : "fixed_not_deployed", sha);
}

export interface CheckInput extends Blame {
  failureAt: string;
  failureAtSource: FailureTimeSource;
  function: string;
  issue: string;
  labels?: Label[];
  readCommit: string;
}

export interface CheckDeps {
  closeNetwork: () => Promise<void>;
  deploy: DeployReads;
  now: () => Date;
  openNetwork: () => Promise<void>;
  remote: string;
  shell: Shell;
  worktree: string;
}

export type CheckResult =
  | { candidates: Candidate[]; status: "labels_needed"; unavailable: string[] }
  | { error: string; status: "error" }
  | { candidates: Candidate[]; record: RegressionRecord; status: "recorded" };

/** What is wrong with the input before any command runs, or null. */
export const inputProblem = (input: CheckInput): string | null => {
  if (!isSha(input.readCommit)) {
    return "readCommit must be a full 40-character commit.";
  }
  if (!Number.isFinite(Date.parse(input.failureAt))) {
    return "failureAt must be an ISO time.";
  }
  return blameProblem(input);
};

const recordOf = (
  input: CheckInput,
  outcome: Resolution,
  deployed: string | null
): RegressionRecord => ({
  ...outcome,
  commitRead: input.readCommit,
  deployedCommit: deployed,
  file: input.file,
  function: input.function,
  issue: input.issue,
  lines: input.lines,
  windowDays: HISTORY_DAYS,
});

const deepenHistory = async (
  deps: CheckDeps,
  input: CheckInput,
  since: string
): Promise<{ ok: true } | Failure> => {
  let opened = false;
  try {
    await deps.openNetwork();
    opened = true;
    return await ensureHistory(deps.shell, {
      readCommit: input.readCommit,
      remote: deps.remote,
      since,
      worktree: deps.worktree,
    });
  } finally {
    if (opened) {
      await deps.closeNetwork();
    }
  }
};

const check = async (
  deps: CheckDeps,
  input: CheckInput
): Promise<CheckResult> => {
  const since = sinceIso(deps.now());
  const unusable = (reason: string): CheckResult => ({
    candidates: [],
    record: recordOf(input, unchecked(reason), null),
    status: "recorded",
  });
  const ensured = await deepenHistory(deps, input, since);
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
  const labelable = listed.candidates.filter((candidate) => candidate.patch);
  if (labelable.length > 0 && !input.labels) {
    return {
      candidates: labelable,
      status: "labels_needed",
      unavailable: listed.candidates
        .filter((candidate) => !candidate.patch)
        .map((candidate) => candidate.sha),
    };
  }
  const bad = labelProblem(labelable, input.labels ?? []);
  if (bad) {
    return { error: bad, status: "error" };
  }
  const live = await deps.deploy.liveSha().then(
    (sha) => (sha && isSha(sha) ? sha : null),
    () => null
  );
  const resolved = await resolveRegression({
    candidates: listed.candidates,
    failureAt: input.failureAt,
    failureAtSource: input.failureAtSource,
    labels: input.labels ?? [],
    live,
    reads: deps.deploy,
  });
  return {
    candidates: labelable,
    record: recordOf(input, resolved, live),
    status: "recorded",
  };
};

/**
 * One check: complete the history, list what touched the blamed lines, and,
 * once the caller has labelled every candidate, resolve the result. Anything
 * the environment gets wrong, a thrown error included, is an `unchecked`
 * record, never `none`.
 */
export async function runCheckRegression(
  deps: CheckDeps,
  input: CheckInput
): Promise<CheckResult> {
  const problem = inputProblem(input);
  if (problem) {
    return { error: problem, status: "error" };
  }
  try {
    return await check(deps, input);
  } catch (error) {
    return {
      candidates: [],
      record: recordOf(
        input,
        unchecked(
          `the check failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300
          )
        ),
        null
      ),
      status: "recorded",
    };
  }
}

/** A record for a workspace that cannot be checked at all (a replay archive). */
export const uncheckedRecord = (
  input: Pick<
    CheckInput,
    "file" | "function" | "issue" | "lines" | "readCommit"
  >,
  reason: string
): RegressionRecord => ({
  ...unchecked(reason),
  commitRead: input.readCommit,
  deployedCommit: null,
  file: input.file,
  function: input.function,
  issue: input.issue,
  lines: input.lines,
  windowDays: HISTORY_DAYS,
});
