import { getToken as getConnectToken } from "@vercel/connect";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  GITHUB_CONNECTOR,
  githubCredentials,
} from "#lib/github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "#lib/github/git-remote.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import {
  type CheckInput,
  type CheckResult,
  runCheckRegression,
  type Shell,
  uncheckedRecord,
} from "#lib/regression-lane.js";
import { regressionRecords } from "#lib/regression-record.js";
import {
  githubChangedFiles,
  githubDeployProbe,
} from "#lib/reporter-updates/deploy.js";
import { DEPLOY_REPOSITORY } from "#lib/reporter-updates/plan.js";
import { readPreparedRepository, remoteUrl } from "#lib/repository.js";
import { boundedRun } from "#lib/sandbox-deadline.js";
import { isTriageReplay } from "#lib/triage-replay/mode.js";
import { environment } from "#sandbox.js";

const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/u)
  .describe("A full 40-character commit.");

export default defineTool({
  description:
    "Before a Bug verdict, check what the last 30 days of history did to the code the cause runs through, and whether production runs it (ENG-16056). " +
    "Read-only. Completes the clone's 30-day history and proves it, lists the commits that touched the blamed line range at readCommit (git follows the lines through earlier revisions), and with a label for every one of them resolves one result: " +
    "'introduced by <sha>', 'fixed on main and live, by <sha>', 'fixed on main, not deployed yet, by <sha>', 'fixed on main, deploy status unknown, by <sha>', 'none', or 'unchecked: <reason>'. " +
    "Call it once without labels to get the commits and their patches, read them, then call it again with a label for each. Commits under unavailable come with a reason: an unavailable commit is a merge git shows no patch for or a patch too long to show whole: never label it, and if it is newer than the deciding commit the result is unchecked. " +
    "Production's commit is read from Acquisity/Acquisity's GitHub production deployments, the same read the reporter updates use; nothing about deployments is passed in. If production has changed the blamed file since readCommit, a fix is never called live: the result is deploy status unknown. " +
    "The record answers only for this file and commit read, and each call replaces the ticket's previous record: decide_triage and the investigation document read it, nothing passes it back in. " +
    "unchecked means the lane could not run or could not prove its history; record it as Could not run and carry on.",
  async execute(input, ctx) {
    regressionRecords.update((all) =>
      Object.fromEntries(
        Object.entries(all).filter(([issue]) => issue !== input.issue)
      )
    );
    const keep = (result: CheckResult) => {
      if (result.status === "recorded") {
        regressionRecords.update((all) => ({
          ...all,
          [input.issue]: result.record,
        }));
      }
      return result;
    };
    const unchecked = (reason: string) =>
      keep({
        candidates: [],
        record: uncheckedRecord(input, reason),
        status: "recorded",
      });
    if (isTriageReplay()) {
      return unchecked("A replay workspace holds no git history to check.");
    }
    try {
      const sandbox = await ctx.getSandbox(environment);
      const prepared = await readPreparedRepository(sandbox);
      if (prepared.slug.toLowerCase() !== DEPLOY_REPOSITORY.toLowerCase()) {
        return {
          error: `The regression check reads ${DEPLOY_REPOSITORY}; the prepared repository is ${prepared.slug}.`,
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
      const appToken = () =>
        getConnectToken(GITHUB_CONNECTOR, { subject: { type: "app" } });
      const probe = githubDeployProbe(appToken);
      return keep(
        await runCheckRegression(
          {
            closeNetwork: () => sandbox.setNetworkPolicy("allow-all"),
            deploy: {
              changedFiles: githubChangedFiles(appToken),
              isAncestor: (base, head) =>
                probe.isAncestor(DEPLOY_REPOSITORY, base, head),
              liveSha: () => probe.liveSha(),
            },
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
        )
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return unchecked(
        `the check could not start: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300
        )
      );
    }
  },
  inputSchema: z.object({
    failureAt: z
      .string()
      .describe(
        "ISO time the customer hit the failure: the time the claim names, else the ticket's creation time."
      ),
    failureAtSource: z.enum(["claim", "ticket-created"]),
    file: z.string().min(1).max(300),
    function: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "The function the range sits in, exactly as decide_triage's codePath names it."
      ),
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
      .describe("The blamed line range in the file at readCommit."),
    readCommit: sha.describe("The commit Stage 4 read the code at."),
  }),
});
