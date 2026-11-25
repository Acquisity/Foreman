import type { ToolContext } from "eve/tools";
import { endpointToolSet, HELD_AREAS } from "./widget-endpoint-tools.js";

export interface LiveTool {
  execute: (input: unknown, ctx: ToolContext) => unknown;
}

/**
 * The tool a `widget:live` re-read calls for a recorded read (ENG-20609): a
 * switched area's generated endpoint tool from the one endpoint map, resolved
 * for the recorded scope's own endpoint list, or else the hand-written tool
 * eve resolves from its file. Null when neither resolves for this scope.
 */
export async function liveTool(
  tool: string,
  ctx: ToolContext,
  held: ReadonlySet<string> = HELD_AREAS
): Promise<LiveTool | null> {
  const endpoint = (
    endpointToolSet(ctx.session.auth.initiator, undefined, held) as Record<
      string,
      LiveTool
    > | null
  )?.[tool];
  if (endpoint) {
    return endpoint;
  }
  const dynamic = (await import(`../tools/${tool}.ts`)).default as {
    events: Record<string, (event: unknown, ctx: unknown) => unknown>;
  };
  return (await dynamic.events["step.started"]({}, ctx)) as LiveTool | null;
}
