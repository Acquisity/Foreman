import type {
  SandboxCommandResult,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";

/**
 * The one deadline every repository operation Foreman runs in a sandbox is
 * bounded by.
 *
 * @remarks
 * Five minutes covers a cold clone plus a dependency install of the largest
 * warmed repository, so it is generous for the single-branch fetches and
 * pushes the station tools run. eve's Vercel invocation ceiling is 800s, so a
 * command that hits this bound still leaves the tool time to return an error
 * instead of dying with the function.
 */
export const REPOSITORY_OPERATION_TIMEOUT_MS = 300_000;

/**
 * The exit code a shell reports for a command killed by `timeout`, reused here
 * so a deadline surfaces through each caller's existing non-zero branch.
 */
export const TIMED_OUT_EXIT_CODE = 124;

/** How far down a `cause` chain the deadline reason is still recognised. */
const MAX_CAUSE_DEPTH = 5;

/** Whether `error` is the deadline reason, or wraps it as a cause. */
const causedBy = (error: unknown, reason: Error): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === reason) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    current = current.cause;
  }
  return false;
};

/**
 * Runs one sandbox command under a deadline.
 *
 * @remarks
 * eve 0.44's sandbox `run` takes an `abortSignal` and no timeout of its own,
 * so the deadline is supplied here. A caller that passes its own signal keeps
 * it: the two are composed, so an already-aborted caller signal still cancels
 * the command instead of being replaced by a fresh deadline.
 *
 * The failure is classified from the thrown reason, not from the local
 * signals. eve wraps a second composition around whatever it is handed and
 * folds the session's own cancellation into it
 * (`bindSandboxAbortSignal`, `eve@0.44.0`), so the winner of the race is only
 * visible in what the command rejects with. A deadline this helper armed comes
 * back as a non-zero result, identified by its own reason object rather than
 * by a timer having merely fired, so every caller's existing failure branch
 * handles it. Anything else, including a session or caller cancellation whose
 * rejection arrives after the deadline expired, still throws.
 */
export const boundedRun = async (
  sandbox: SandboxSession,
  options: SandboxRunOptions,
  timeoutMs: number = REPOSITORY_OPERATION_TIMEOUT_MS
): Promise<SandboxCommandResult> => {
  const expired = new Error(`timed out after ${timeoutMs}ms`);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(expired), timeoutMs);
  const composed = options.abortSignal
    ? AbortSignal.any([options.abortSignal, deadline.signal])
    : deadline.signal;
  try {
    return await sandbox.run({ ...options, abortSignal: composed });
  } catch (error) {
    if (!causedBy(error, expired)) {
      throw error;
    }
    return {
      exitCode: TIMED_OUT_EXIT_CODE,
      stderr: expired.message,
      stdout: "",
    };
  } finally {
    clearTimeout(timer);
  }
};
