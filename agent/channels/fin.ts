import { defineChannel, POST } from "eve/channels";
import { toolResultFrom } from "eve/tools";
import type { FinCaseOutcome } from "../lib/fin-case.js";
import { receiveFinContext } from "../lib/fin-context-route.js";
import { receiveFinInvestigation } from "../lib/fin-investigation.js";
import {
  finInvestigationFailure,
  reduceFinEvent,
} from "../lib/fin-investigation-callback.js";
import type { FinInvestigationSlackReceipt } from "../lib/fin-investigation-slack.js";
import { finishFinRun } from "../lib/fin-run-completion.js";
import { finCaseTicketTool } from "../tools/file_fin_investigation_ticket.js";

export default defineChannel({
  context: (state) => ({ state }),
  events: {
    // A missing ticket outcome is ordinary. The last result of the turn wins.
    "action.result"(event, channel) {
      const match = toolResultFrom(event.result, finCaseTicketTool);
      if (match) {
        channel.state.ticket = match.output;
      }
    },
    "message.completed"(event, channel) {
      channel.state.answer = reduceFinEvent(channel.state.answer, {
        finishReason: event.finishReason,
        message: event.message,
        type: "message.completed",
      }).answer;
    },
    async "session.completed"(_event, channel, ctx) {
      const { outcome } = reduceFinEvent(channel.state.answer, {
        type: "session.completed",
      });
      const ticket = channel.state.ticket ?? undefined;
      await finishFinRun(
        channel.state.runId,
        ctx.session.id,
        channel.state.slack,
        {
          ...(outcome ?? finInvestigationFailure),
          ...(ticket ? { ticket } : {}),
        }
      );
    },
    async "session.failed"(event, channel) {
      await finishFinRun(
        channel.state.runId,
        event.sessionId,
        channel.state.slack,
        finInvestigationFailure
      );
    },
    "turn.started"(_event, channel) {
      channel.state.answer = reduceFinEvent(channel.state.answer, {
        type: "turn.started",
      }).answer;
    },
  },
  routes: [
    POST("/internal/fin/context", (request) => receiveFinContext(request)),
    POST("/internal/fin/investigation", receiveFinInvestigation),
  ],
  state: {
    answer: "",
    runId: null as string | null,
    slack: null as FinInvestigationSlackReceipt | null,
    ticket: null as FinCaseOutcome | null,
  },
});
