import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { isFinInvestigation } from "../fin-investigation-auth.js";
import { sessionLane } from "../session-lane.js";
import { executorAuth } from "./auth.js";
import {
  type ExecutorToolkit,
  FIN_PREVIEW_TOOLKIT,
  FOREMAN_TOOLKIT_SLUG,
  toolkitUrl,
} from "./endpoint.js";

/** One company toolkit shared by root, critic, workflows, and authored helpers. */
export const executorConnection = (toolkit?: ExecutorToolkit) =>
  defineMcpClientConnection({
    approval: (ctx) => {
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
      "Foreman company connections. Discover tools inside execute using tools.search and tools.describe.tool. Prefer the authored helpers for bounded evidence reads. Personal Supermemory is separate.",
    instanceKey: toolkit ?? FOREMAN_TOOLKIT_SLUG,
    tools: { allow: ["execute", "skills"] },
    url: toolkitUrl(toolkit),
  });

export const sessionExecutorConnection = () =>
  defineDynamic({
    events: {
      "session.started": (_event, ctx) =>
        executorConnection(
          isFinInvestigation(ctx.session.auth.initiator)
            ? FIN_PREVIEW_TOOLKIT
            : undefined
        ),
    },
  });
