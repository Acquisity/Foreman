import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  type ActionAttestation,
  type AttestationRejection,
  attestationProblem,
  findActionStatements,
  gateForTurn,
  recordAttestation,
  slackDeliveryGate,
} from "#lib/slack-delivery.js";

const sentence = z
  .string()
  .trim()
  .min(10)
  .max(1000)
  .describe(
    "The exact sentence the Slack reply will contain, word for word. The delivery gate matches it verbatim."
  );

const evidence = (what: string) =>
  z.string().trim().min(20).max(2000).describe(what);

const REASONS: Record<AttestationRejection, string> = {
  "owner-not-named":
    "The sentence must name the owner exactly as given, and the owner cannot be Foreman, I, or we.",
  "unproven-completion":
    "No successful result from that tool exists in this turn. A failed, denied, or unattempted write is not completed; say that no action was taken instead.",
};

export default defineTool({
  description:
    "Register one action sentence before it goes into a final Slack reply. The Slack channel refuses to post any sentence that promises, offers, recommends, or reports an operation unless it was attested here this turn with the evidence the state needs. `completed` is for an action a tool in this turn actually performed: name the tool, and the channel checks that it returned successfully. `available` is for an option nobody has performed: give the verified procedure, the evidence it is feasible for this case, its safety constraints, the owner authorized to perform it with the evidence of that authority, and any approval or input it needs; the sentence must name that owner and must read as their option, not your promise. If any of those facts is missing, do not attest and do not write the sentence: say that no safe action was confirmed and name only the missing evidence.",
  execute(input, ctx) {
    if (findActionStatements(input.sentence).length === 0) {
      return {
        reason:
          "That sentence contains no action statement, so it needs no attestation and none was recorded.",
        recorded: false as const,
      };
    }
    const attestation: ActionAttestation =
      input.state === "completed"
        ? {
            sentence: input.sentence,
            state: "completed",
            toolName: input.toolName,
          }
        : { owner: input.owner, sentence: input.sentence, state: "available" };
    const turnId = ctx.session.turn.id;
    const problem = attestationProblem(
      attestation,
      gateForTurn(slackDeliveryGate.get(), turnId).succeededTools
    );
    if (problem !== null) {
      return { reason: REASONS[problem], recorded: false as const };
    }
    recordAttestation(slackDeliveryGate, turnId, attestation);
    return { recorded: true as const };
  },
  inputSchema: z.discriminatedUnion("state", [
    z.object({
      sentence,
      state: z.literal("completed"),
      toolName: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          "The tool whose successful result in this turn performed the action, as you called it (for example `linear__save_issue`)."
        ),
    }),
    z.object({
      approval: evidence(
        "The approval or input the owner needs before acting, or an explicit statement that none is required and why."
      ),
      feasibility: evidence(
        "The current-run evidence that the procedure works for this case."
      ),
      owner: z
        .string()
        .trim()
        .min(2)
        .max(100)
        .describe(
          "Who is authorized and able to perform it, named exactly as the sentence names them."
        ),
      ownerEvidence: evidence(
        "How the investigation verified that this owner is authorized and able to perform it."
      ),
      procedure: evidence(
        "The known product feature, provider operation, or documented procedure, and where it was verified."
      ),
      safety: evidence(
        "Why it is safe for the customer's data, money, configuration, and workflow, with any constraints."
      ),
      sentence,
      state: z.literal("available"),
    }),
  ]),
  outputSchema: z.object({
    reason: z.string().optional(),
    recorded: z.boolean(),
  }),
});
