import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { describeProvider, invokeProvider } from "../lib/executor/dispatch.js";
import { WIDGET_PATHS } from "../lib/widget-catalog.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

const WORDS = /\s+/;
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), query: z.string().max(200) }),
  z.object({ action: z.literal("describe"), path: z.string().max(200) }),
  z.object({
    action: z.literal("call"),
    input: z.record(z.string(), z.unknown()),
    path: z.string().max(200),
  }),
]);

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Discover and call the read-only company-provider operations available to this support investigation. Search paths, describe the exact input schema, then call one operation with its input. Every result is evidence about the verified workspace only when its rows carry that workspace's identifiers; note the tool and reference for each fact you keep.",
  execute(input, ctx) {
    if (!isWidgetSupport(ctx.session.auth.initiator)) {
      throw new Error("Support widget identity required.");
    }
    if (input.action === "search") {
      const terms = input.query.toLowerCase().split(WORDS).filter(Boolean);
      return {
        paths: WIDGET_PATHS.filter((path) =>
          terms.every((term) => path.toLowerCase().includes(term))
        ),
      };
    }
    if (input.action === "describe") {
      return describeProvider(ctx, input.path);
    }
    if (JSON.stringify(input.input).length > 100_000) {
      throw new Error("Provider input exceeds its bound.");
    }
    return invokeProvider(ctx, input.path, input.input);
  },
  inputSchema,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
