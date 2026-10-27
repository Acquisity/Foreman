import { defineMcpClientConnection } from "eve/connections";
import {
  isQuestionsOnlySession,
  QUESTIONS_ONLY_REASON,
} from "../github/approval.js";
import { sessionLane } from "../session-lane.js";
import { isTriageReplay } from "../triage-replay/mode.js";
import { executorAuth } from "./auth.js";
import { toolkitUrl } from "./endpoint.js";

/** One company toolkit shared by root, critic, workflows, and authored helpers. */
export const executorConnection = () =>
  defineMcpClientConnection({
    approval: (ctx) => {
      if (isTriageReplay()) {
        return {
          reason:
            "Triage replay: the Linear connection is closed. Read issues with read_triage_replay_issue, comment with comment_triage_replay_issue and create an issue with create_triage_replay_issue; production evidence is unavailable.",
          type: "denied",
        };
      }
      // A questions-only Slack session never reaches Linear writes; one execute
      // call can run any company operation, so the whole gateway is denied.
      if (isQuestionsOnlySession(ctx.session.auth)) {
        return { reason: QUESTIONS_ONLY_REASON, type: "denied" };
      }
      if (!sessionLane(ctx.session.auth.initiator).broadExecutor) {
        return {
          reason:
            "Use support_provider for the support toolkit and durable Linear writes.",
          type: "denied",
        };
      }
      return ["execute", "skills"].some(
        (name) => ctx.toolName === name || ctx.toolName.endsWith(`__${name}`)
      )
        ? "not-applicable"
        : { reason: "Use Executor execute or skills.", type: "denied" };
    },
    auth: () => executorAuth(),
    description:
      "Foreman company connections. Discover tools inside execute using tools.search and tools.describe.tool. Prefer the authored helpers for bounded evidence reads.",
    tools: { allow: ["execute", "skills"] },
    url: toolkitUrl(),
  });
