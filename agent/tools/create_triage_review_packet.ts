import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModel } from "#lib/models.js";
import { readPreparedRepository } from "#lib/repository.js";
import {
  hashTriageReviewPacket,
  serializeTriageReviewPacket,
  stampTriageReviewPolicy,
  TRIAGE_REVIEW_PACKET_DIRECTORY,
  TRIAGE_REVIEW_PACKET_VERSION,
  triageReviewPacketInputSchema,
  triageReviewPacketPath,
} from "#lib/triage-review-packet.js";
import { isIntakeOnly } from "#lib/trust.js";

export default defineTool({
  description:
    "Create the immutable, hash-bound evidence packet for a proposed Bug before calling triage-critic. The prepared repository and current HEAD must match the packet's code anchor. Create a new packet after any evidence, code SHA, blast-radius method, master candidate, proposed decision, or structural write changes. This tool does not approve the packet or write to an external service.",
  async execute(input, ctx) {
    try {
      const stampedInput = stampTriageReviewPolicy(input, {
        evaluatedAt: new Date().toISOString(),
        intakeOnly: isIntakeOnly(ctx.session.auth.current),
      });
      const sandbox = await ctx.getSandbox();
      const prepared = await readPreparedRepository(sandbox);
      if (
        prepared.slug.toLowerCase() !==
        stampedInput.diagnosis.codeAnchor.repository.toLowerCase()
      ) {
        return {
          error: `The packet names ${stampedInput.diagnosis.codeAnchor.repository}, but the prepared repository is ${prepared.slug}.`,
          success: false as const,
        };
      }

      const revision = await sandbox.run({
        command: "git rev-parse HEAD",
        workingDirectory: prepared.worktree,
      });
      const headSha = String(revision.stdout).trim();
      if (
        revision.exitCode !== 0 ||
        headSha !== stampedInput.diagnosis.codeAnchor.commitSha
      ) {
        return {
          error:
            "The prepared repository is not at the packet's recorded commit SHA. Refresh the code evidence and build a new packet.",
          success: false as const,
        };
      }

      const packet = {
        ...stampedInput,
        criticModel: await resolveModel("triageCritic"),
        packetVersion: TRIAGE_REVIEW_PACKET_VERSION,
      };
      const serialized = serializeTriageReviewPacket(packet);
      const evidenceRevision = hashTriageReviewPacket(serialized);
      const path = triageReviewPacketPath(evidenceRevision);
      await sandbox.run({
        command: `mkdir -p ${TRIAGE_REVIEW_PACKET_DIRECTORY}`,
      });
      const existing = await sandbox.readTextFile({ path });
      if (existing !== null && existing !== serialized) {
        return {
          error: "The evidence revision already exists with different content.",
          success: false as const,
        };
      }
      if (existing === null) {
        await sandbox.writeTextFile({ content: serialized, path });
      }
      return {
        bytes: Buffer.byteLength(serialized),
        criticModel: packet.criticModel,
        evidenceRevision,
        masterEligibilityEvaluatedAt:
          stampedInput.proposal.masterEligibilityEvaluatedAt,
        masterRecencyPolicy: stampedInput.proposal.masterRecencyPolicy,
        path,
        reused: existing !== null,
        success: true as const,
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Could not create the triage review packet.",
        success: false as const,
      };
    }
  },
  inputSchema: triageReviewPacketInputSchema,
  outputSchema: z.object({
    bytes: z.number().optional(),
    criticModel: z.string().optional(),
    error: z.string().optional(),
    evidenceRevision: z.string().optional(),
    masterEligibilityEvaluatedAt: z.iso.datetime().optional(),
    masterRecencyPolicy: z.enum(["UNBOUNDED", "THIRTY_DAY"]).optional(),
    path: z.string().optional(),
    reused: z.boolean().optional(),
    success: z.boolean(),
  }),
});
