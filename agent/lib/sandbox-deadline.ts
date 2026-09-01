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

/**
 * Runs one sandbox command under a deadline.
 *
 * @remarks
 * eve 0.44's sandbox `run` takes an `abortSignal` and no timeout of its own,
 * and it composes the signal with the session's, so `AbortSignal.timeout` is
 * the version-matched bound. A caller that passes its own signal keeps it:
 * the two are composed, so an already-aborted caller signal still cancels the
 * command instead of being replaced by a fresh deadline.
 *
 * The failure is classified from the composed signal's reason, which latches
 * whichever signal aborted first. A deadline comes back as a non-zero result
 * so every caller's existing failure branch handles it; anything else,
 * including a cancelled turn, still throws, even when the deadline fires
 * afterwards while the rejection is in flight.
 */
export const boundedRun = async (
  sandbox: SandboxSession,
  options: SandboxRunOptions,
  timeoutMs: number = REPOSITORY_OPERATION_TIMEOUT_MS
): Promise<SandboxCommandResult> => {
  const deadline = AbortSignal.timeout(timeoutMs);
  const composed = options.abortSignal
    ? AbortSignal.any([options.abortSignal, deadline])
    : deadline;
  try {
    return await sandbox.run({ ...options, abortSignal: composed });
  } catch (error) {
    if (!(deadline.aborted && composed.reason === deadline.reason)) {
      throw error;
    }
    return {
      exitCode: TIMED_OUT_EXIT_CODE,
      stderr: `timed out after ${timeoutMs}ms`,
      stdout: "",
    };
  }
};
