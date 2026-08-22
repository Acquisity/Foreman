import { defineTool } from "eve/tools";
import { z } from "zod";
import { intakeOnlyPolicy, pullRequestReadinessPolicy } from "./approval.js";

/**
 * Durable callbacks for the GitHub extension's dynamic tools.
 *
 * @remarks
 * eve 0.44 requires every callback on a dynamic tool to carry a durable
 * descriptor so a parked call can rebuild it in a fresh process. eve stamps one
 * only on a callback authored inline inside a `defineTool({ ... })` call in a
 * module it transforms, and it rejects the resolver's entire result when a
 * single entry is missing one. The whole GitHub surface is one dynamic tool
 * returning all 31 entries, so one bare callback removes every `github__` tool
 * from the session, with nothing logged to the model. The eve 0.40 to 0.44
 * upgrade did exactly that.
 *
 * Two kinds of callback reach that resolver from outside a transformed
 * `defineTool` call: the `toModelOutput` the extension reads off its own
 * prebuilt dist, and any approval policy passed through `overrides`. Neither
 * can be stamped where it is written, so both are authored inline below and the
 * extension config passes these stamped functions instead.
 *
 * The definitions here are callback carriers, not tools. They live under
 * `agent/lib`, which eve does not scan for tools, and only their callbacks are
 * ever read.
 */
const CARRIER_INPUT = z.record(z.string(), z.unknown());

/** Per-file patch limit, matching the one the extension's dist applies. */
const MAX_PATCH_LENGTH = 4000;

/** File body limit, matching the one the extension's dist applies. */
const MAX_CONTENT_LENGTH = 20_000;

const truncate = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[truncated: ${text.length - limit} more characters]`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const truncatePatches = (files: readonly unknown[]) =>
  files.map((file) =>
    isRecord(file) && typeof file.patch === "string"
      ? { ...file, patch: truncate(file.patch, MAX_PATCH_LENGTH) }
      : file
  );

/**
 * Keeps a large diff or file body out of the context window, the one thing the
 * extension's own `toModelOutput` did for the five tools that carry one.
 *
 * @remarks
 * One projection covers all five, because their outputs take only three
 * shapes: a bare array of files (`listPullRequestFiles`), an object holding
 * one (`getCommit`, `compareCommits`, `getPullRequestContext`), or a file body
 * (`getFileContent`). Anything else passes through untouched.
 */
export const compactGithubOutput = (output: unknown): unknown => {
  if (Array.isArray(output)) {
    return truncatePatches(output);
  }
  if (!isRecord(output)) {
    return output;
  }
  if (typeof output.content === "string") {
    return { ...output, content: truncate(output.content, MAX_CONTENT_LENGTH) };
  }
  return Array.isArray(output.files)
    ? { ...output, files: truncatePatches(output.files) }
    : output;
};

const pullRequestCreationCarrier = defineTool({
  approval: intakeOnlyPolicy,
  description: "Durable callback carrier, never registered as a tool.",
  execute: (): unknown => null,
  inputSchema: CARRIER_INPUT,
  toModelOutput: (output: unknown) => ({
    type: "json" as const,
    value: compactGithubOutput(output),
  }),
});

const pullRequestUpdateCarrier = defineTool({
  approval: pullRequestReadinessPolicy,
  description: "Durable callback carrier for the readiness gate.",
  execute: (): unknown => null,
  inputSchema: CARRIER_INPUT,
});

/** {@link intakeOnlyPolicy}, stamped. */
export const durableIntakeOnlyApproval = pullRequestCreationCarrier.approval;

/** {@link pullRequestReadinessPolicy}, stamped. */
export const durableReadinessApproval = pullRequestUpdateCarrier.approval;

/** {@link compactGithubOutput}, stamped. */
export const durableModelOutput = pullRequestCreationCarrier.toModelOutput;
