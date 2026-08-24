import type { RuntimeSandboxSession } from "eve/sandbox";
import { readPreparedRepository } from "./repository.js";
import {
  canonicalizeTriageReviewValue,
  hashTriageReviewPacket,
  type TriageReviewPacket,
  triageReviewPacketPath,
  triageReviewPacketSchema,
} from "./triage-review-packet.js";

export type VerifiedPacketResult =
  | { readonly packet: TriageReviewPacket; readonly verified: true }
  | { readonly reason: string; readonly verified: false };

export const readVerifiedTriageReviewPacket = async (
  sandbox: RuntimeSandboxSession,
  evidenceRevision: string
): Promise<VerifiedPacketResult> => {
  try {
    const serialized = await sandbox.readTextFile({
      path: triageReviewPacketPath(evidenceRevision),
    });
    if (serialized === null) {
      return {
        reason: "No packet exists for that evidence revision.",
        verified: false,
      };
    }
    const rawPacket: unknown = JSON.parse(serialized);
    const packet = triageReviewPacketSchema.parse(rawPacket);
    const canonical = JSON.stringify(
      canonicalizeTriageReviewValue(rawPacket),
      null,
      2
    );
    if (hashTriageReviewPacket(canonical) !== evidenceRevision) {
      return {
        reason: "The packet content does not match the evidence revision.",
        verified: false,
      };
    }

    const prepared = await readPreparedRepository(sandbox);
    const revision = await sandbox.run({
      command: "git rev-parse HEAD",
      workingDirectory: prepared.worktree,
    });
    const matches =
      revision.exitCode === 0 &&
      prepared.slug.toLowerCase() ===
        packet.diagnosis.codeAnchor.repository.toLowerCase() &&
      String(revision.stdout).trim() === packet.diagnosis.codeAnchor.commitSha;
    return matches
      ? { packet, verified: true }
      : {
          reason:
            "The prepared repository no longer matches the packet's repository and commit SHA.",
          verified: false,
        };
  } catch {
    return {
      reason: "The packet could not be parsed or verified.",
      verified: false,
    };
  }
};
