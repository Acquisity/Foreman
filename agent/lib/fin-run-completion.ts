import { inspectFinDelivery } from "./fin-delivery.js";
import {
  createFinCallback,
  deliverFinCallback,
  type FinInvestigationOutcome,
} from "./fin-investigation-callback.js";
import {
  type FinInvestigationSlackReceipt,
  updateFinInvestigationReceipt,
} from "./fin-investigation-slack.js";
import {
  completeFinRun,
  markFinCallback,
  reserveFinCallback,
} from "./fin-run-store.js";
import { logOpsEvent } from "./ops-log.js";

export async function finishFinRun(
  runId: string | null,
  sessionId: string,
  slack: FinInvestigationSlackReceipt | null,
  outcome: FinInvestigationOutcome,
  operations = {
    callback: deliverFinCallback,
    complete: completeFinRun,
    inspect: inspectFinDelivery,
    mark: markFinCallback,
    reserve: reserveFinCallback,
    slack: updateFinInvestigationReceipt,
  }
) {
  // Internal reporting is independent of customer authorization and callback failure.
  const completed = runId
    ? operations.complete(runId, outcome, sessionId).catch(() => null)
    : Promise.resolve(null);
  await Promise.all([
    completed.then((run) => {
      const saved = run?.outcome ?? outcome;
      const { ticket } = saved;
      return operations.slack(
        slack,
        ticket
          ? {
              ...saved,
              message: `${saved.message}\n\nTicket: ${ticket.outcome}. ${ticket.message}${ticket.identifier ? ` (${ticket.identifier})` : ""}`,
            }
          : saved
      );
    }),
    (async () => {
      if (!runId) {
        return;
      }
      try {
        // Bind the emitting session and save its outcome in one fenced write.
        const run = await completed;
        if (!run) {
          throw new Error("Run completion unavailable.");
        }
        if ((await operations.inspect(run.scope)).humanReplied) {
          return;
        }
        if (!(run.callback_url && (await operations.reserve(run.id)))) {
          return;
        }
        const callback = createFinCallback(run.callback_url);
        await operations.callback(callback, sessionId, run.outcome ?? outcome);
        if (callback?.delivered) {
          await operations.mark(run.id);
        }
      } catch {
        logOpsEvent(
          "fin.investigation.delivery.unavailable",
          { outcome: "error", sessionId },
          console.warn
        );
      }
    })(),
  ]);
}
