import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "#lib/github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "#lib/github/git-remote.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import {
  type CheckInput,
  runCheckRegression,
  type Shell,
  uncheckedRecord,
} from "#lib/regression-lane.js";
import { regressionRecords } from "#lib/regression-record.js";
import { readPreparedRepository, remoteUrl } from "#lib/repository.js";
import { boundedRun } from "#lib/sandbox-deadline.js";
import { isTriageReplay } from "#lib/triage-replay/mode.js";
import { environment } from "#sandbox.js";

const CHECKED_REPOSITORY = "acquisity/acquisity";
const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/u)
  .describe("A full 40-character commit.");
const deployment = z.object({
  commit: sha,
  readyAt: z.string().describe("ISO time the deployment became ready."),
});

export default defineTool({
  description:
    "Before a Bug verdict, check what the last 30 days of history did to the code the cause runs through, and whether production runs it (ENG-16056). " +
    "Read-only. Deepens a shallow clone, lists the commits that touched the blamed lines (or string), and with a label for every one of them resolves one result: " +
    "'introduced by <sha>', 'fixed on main and live, by <sha>', 'fixed on main, not deployed yet, by <sha>', 'fixed on main, deploy status unknown, by <sha>', 'none', or 'unchecked: <reason>'. " +
    "Call it once without labels to get the commits and their patches, read them, then call it again with a label for each. " +
    "deployments.current is the deployment production serves now (so a rollback shows as an older commit); deployments.timeline is the production READY deployments newest first, paged back to a deployment older than failureAt. " +
    "The record is kept for the session: decide_triage and the investigation document read it, nothing passes it back in. " +
    "unchecked means the lane could not run; record it as Could not run and carry on.",
  async execute(input, ctx) {
    const record = (value: ReturnType<typeof uncheckedRecord>) => {
      regressionRecords.update((all) => ({ ...all, [input.issue]: value }));
      return { candidates: [], record: value, status: "recorded" as const };
    };
    if (isTriageReplay()) {
      return record(
        uncheckedRecord(
          input.issue,
          input.readCommit,
          "A replay workspace holds no git history to check."
        )
      );
    }
    const sandbox = await ctx.getSandbox(environment);
    const prepared = await readPreparedRepository(sandbox);
    if (prepared.slug.toLowerCase() !== CHECKED_REPOSITORY) {
      return {
        error: `The regression check reads ${CHECKED_REPOSITORY}; the prepared repository is ${prepared.slug}.`,
        status: "error" as const,
      };
    }
    const shell: Shell = async (command) => {
      const result = await boundedRun(sandbox, { command });
      return {
        exitCode: result.exitCode,
        stderr: String(result.stderr),
        stdout: String(result.stdout),
      };
    };
    const result = await runCheckRegression(
      {
        closeNetwork: () => sandbox.setNetworkPolicy("allow-all"),
        now: () => new Date(),
        openNetwork: async () => {
          const token = await mintInstallationToken(githubCredentials);
          await sandbox.setNetworkPolicy(brokerPolicy(token));
        },
        remote: remoteUrl(prepared.slug),
        shell,
        worktree: prepared.worktree,
      },
      input satisfies CheckInput
    );
    if (result.status === "recorded") {
      regressionRecords.update((all) => ({
        ...all,
        [input.issue]: result.record,
      }));
    }
    return result;
  },
  inputSchema: z.object({
    deployments: z.object({
      current: deployment
        .nullable()
        .describe("What production serves now, or null if unreadable."),
      timeline: z.array(deployment).max(50),
    }),
    failureAt: z
      .string()
      .describe(
        "ISO time the customer hit the failure: the time the claim names, else the ticket's creation time."
      ),
    failureAtSource: z.enum(["claim", "ticket-created"]),
    file: z.string().min(1).max(300),
    issue: z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN),
    labels: z
      .array(
        z.object({
          role: z
            .enum(["fixed", "introduced", "neither"])
            .describe(
              "fixed: the change removes the failure. introduced: it creates or restores it. neither: it touches the code without changing the behaviour."
            ),
          sha,
        })
      )
      .max(25)
      .optional()
      .describe(
        "One label for every commit the first call returned; omit on the first call."
      ),
    lines: z
      .object({ end: z.number().int(), start: z.number().int() })
      .optional()
      .describe("The blamed line range in the file at readCommit."),
    needle: z
      .string()
      .max(200)
      .optional()
      .describe("A distinctive string instead of a line range."),
    readCommit: sha.describe("The commit Stage 4 read the code at."),
  }),
});
