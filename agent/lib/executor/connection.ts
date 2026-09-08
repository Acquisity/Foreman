import { defineMcpClientConnection } from "eve/connections";
import { executorAuth } from "./auth.js";
import { toolkitUrl } from "./endpoint.js";

/** One company toolkit shared by root, critic, workflows, and authored helpers. */
export const executorConnection = () =>
  defineMcpClientConnection({
    approval: (ctx) =>
      ["execute", "skills"].some(
        (name) => ctx.toolName === name || ctx.toolName.endsWith(`__${name}`)
      )
        ? "not-applicable"
        : { reason: "Use Executor execute or skills.", type: "denied" },
    auth: () => executorAuth(),
    description:
      "Foreman company connections. Discover tools inside execute using tools.search and tools.describe.tool. Prefer the authored helpers for bounded evidence reads. Personal Supermemory is separate.",
    tools: { allow: ["execute", "skills"] },
    url: toolkitUrl(),
  });
