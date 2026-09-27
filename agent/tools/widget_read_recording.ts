import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  invokeProvider,
  type ProviderContext,
} from "../lib/executor/dispatch.js";
import { RECORDING_READS } from "../lib/widget-policy.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  widgetContext,
} from "../lib/widget-scope.js";

const PART_CHARS = 3000;
const READ_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 30_000;

const text = (data: unknown) => {
  const content = (data as { content?: unknown } | null)?.content;
  const parts = Array.isArray(content)
    ? content.flatMap((part: { text?: unknown } | null) =>
        typeof part?.text === "string" ? [part.text] : []
      )
    : [];
  const raw = parts.length ? parts.join("\n") : JSON.stringify(data ?? null);
  return raw.length > PART_CHARS ? `${raw.slice(0, PART_CHARS)}…` : raw;
};

/**
 * The screen recording the customer sent from this chat, read through its own
 * Jam id only: the id comes from the verified session, never from the model,
 * and the lane policy refuses any other id.
 */
export async function readRecording(ctx: ProviderContext, jamId: string) {
  const reads = await Promise.all(
    Object.entries(RECORDING_READS).map(async ([key, { path, input }]) => {
      try {
        const result = await invokeProvider(
          ctx,
          path,
          { ...input, jamId },
          undefined,
          { maxBytes: READ_BYTES, timeoutMs: READ_TIMEOUT_MS }
        );
        return [key, result.ok ? text(result.data) : null] as const;
      } catch (error) {
        if (ctx.abortSignal.aborted) {
          throw error;
        }
        return [key, null] as const;
      }
    })
  );
  const read = Object.fromEntries(reads.filter(([, value]) => value !== null));
  return Object.keys(read).length
    ? {
        ...read,
        unavailable: reads.flatMap(([key, value]) =>
          value === null ? [key] : []
        ),
      }
    : { error: "The screen recording could not be read." };
}

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Read the screen recording the customer sent from this chat: what it is, the browser console errors and warnings, the failed network requests, the customer's clicks and page changes, and what they said while recording. Call it first when the customer sent a recording. An app error or a failed request that matches what they describe is evidence of a platform fault. An error set means the recording could not be read: answer from the conversation instead.",
  execute(_input, ctx) {
    const { recordingId } = requireWidgetContext(ctx.session.auth.initiator);
    if (!recordingId) {
      return { error: "No screen recording was sent with this message." };
    }
    return readRecording(ctx, recordingId);
  },
  inputSchema: z.strictObject({}),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      widgetContext(ctx.session.auth.initiator)?.recordingId ? tool : null,
  },
});
