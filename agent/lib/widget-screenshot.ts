import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { gateway, generateObject } from "ai";
import { z } from "zod";
import { sniffImage } from "../subagents/vision/tools/read_image.js";
import { readRequestBody } from "./bounded-body.js";
import { fastCallOptions, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import { verifyWidgetContext } from "./widget-context.js";
import { serviceSecretRefusal } from "./widget-service-secret.js";

/**
 * Reads a screenshot the customer attached in the support widget, while they
 * are still typing.
 *
 * @remarks
 * The app calls this the moment an image is attached and keeps the returned
 * text with the message; on send, that text travels beside the customer's words
 * and every front-door stage and the investigator read it as text. Jev only
 * reads text, so the image has to be words before routing. One direct call on
 * the vision slot, not the vision subagent: a child session costs extra round
 * trips the customer would wait on. Measured through the gateway 2026-09-24 on
 * six real app screenshots: gemini-3.5-flash 1.7 to 6s (about 2.7s average);
 * flash-lite about 1.4s but missed highlighted controls and banner text.
 *
 * The same afternoon the first preview read took 18s: gemini-3.5-flash through
 * the gateway is bimodal, about 1.8s or a 15 to 20s stall, with or without
 * structured output. So a read still running after {@link HEDGE_AFTER_MS} is
 * raced by one on {@link BACKUP_MODEL}, and the first to finish wins.
 */

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
// base64 of the largest image plus the scope fields.
const MAX_BODY_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024;
const READ_TIMEOUT_MS = 20_000;
const HEDGE_AFTER_MS = 4000;
const BACKUP_MODEL = "google/gemini-3.5-flash-lite";
const bearer = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;

const inputSchema = z
  .strictObject({
    // Absent for the first message of a new chat: the chat does not exist yet.
    conversation_id: z.uuid().optional(),
    image: z.base64().max(MAX_BODY_CHARS),
    organization_id: z.uuid(),
    // A support teammate attached it in the inbox. The app then checks the
    // teammate against the conversation, as it does for an inbox investigation.
    staff: z.boolean().optional(),
  })
  .refine((input) => !input.staff || input.conversation_id, {
    message: "A teammate's screenshot names its conversation.",
  });

const readingSchema = z.object({
  error_text: z
    .array(z.string())
    .describe(
      "Only error, warning or status messages, verbatim, at most three. Not ordinary page or chat text."
    ),
  notable: z
    .string()
    .describe(
      "What looks highlighted, circled, empty, disabled, failed or otherwise wrong."
    ),
  screen: z
    .string()
    .describe("Which Acquisity screen or feature this is, in a few words."),
  unreadable: z
    .array(z.string())
    .describe("What could not be read with confidence."),
});
export type ScreenshotReading = z.infer<typeof readingSchema>;

const READ_PROMPT =
  "A customer of Acquisity, a sales and marketing SaaS app, attached this screenshot to a support chat. Report only what is visible. Say which screen it is, name the main buttons, tabs and actions visible, transcribe any error, warning or status message verbatim (not ordinary page or chat text), note what looks highlighted, circled, empty, disabled, failed or otherwise wrong, and list what you could not read. Never guess at text you cannot read. Be brief.";

export async function readScreenshot(
  image: Buffer,
  mediaType: string,
  signal: AbortSignal,
  readWith = readOnce
): Promise<ScreenshotReading> {
  const settled = new AbortController();
  const scoped = AbortSignal.any([signal, settled.signal]);
  const primary = readWith(
    await resolveModel("vision"),
    image,
    mediaType,
    scoped
  );
  const backup = (async () => {
    await Promise.race([
      sleep(HEDGE_AFTER_MS, undefined, { signal: scoped }),
      // A failed primary starts the backup at once; a successful one never
      // does, since the abort below ends the wait first.
      primary.then(
        () => new Promise<never>(() => undefined),
        () => undefined
      ),
    ]);
    return readWith(BACKUP_MODEL, image, mediaType, scoped);
  })();
  try {
    return await Promise.any([primary, backup]);
  } finally {
    settled.abort();
  }
}

async function readOnce(
  model: string,
  image: Buffer,
  mediaType: string,
  signal: AbortSignal
): Promise<ScreenshotReading> {
  const { object } = await generateObject({
    abortSignal: AbortSignal.any([
      signal,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    ]),
    // A stalled call is raced by the backup, never retried in place.
    maxRetries: 0,
    messages: [
      {
        content: [{ data: image, mediaType, type: "file" }],
        role: "user",
      },
    ],
    model: gateway(model),
    schema: readingSchema,
    system: READ_PROMPT,
    ...fastCallOptions(model),
  });
  return object;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}...` : text;

/** The message route accepts a screenshot reading of at most this many characters. */
const MAX_READING_CHARS = 1500;
const TRUNCATED = " [reading cut short]";

/** The reading as the message carries it: labelled, so no reader takes it for the customer's own words. */
export function renderReading(reading: ScreenshotReading): string {
  const errors = reading.error_text
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => `"${clip(line, 200)}"`);
  const unreadable = reading.unreadable
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  const text = [
    "[Screenshot the customer attached, as read by an image model]",
    `Screen: ${clip(reading.screen.trim(), 150)}`,
    errors.length ? `Text shown: ${errors.join("; ")}` : null,
    reading.notable.trim()
      ? `What stands out: ${clip(reading.notable.trim(), 400)}`
      : null,
    unreadable.length
      ? `Could not read: ${clip(unreadable.join("; "), 200)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return text.length > MAX_READING_CHARS
    ? `${text.slice(0, MAX_READING_CHARS - TRUNCATED.length)}${TRUNCATED}`
    : text;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "cache-control": "no-store" }, status });

export async function receiveWidgetScreenshot(
  request: Request,
  verifyContext = verifyWidgetContext,
  read = readScreenshot
): Promise<Response> {
  const refused = serviceSecretRefusal(request);
  if (refused) {
    return refused;
  }
  const userToken = bearer.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (!userToken) {
    return json({ error: "Identity required." }, 401);
  }
  let input: z.infer<typeof inputSchema>;
  try {
    const body = await readRequestBody(request, 15_000, MAX_BODY_CHARS);
    if (body === null) {
      return json({ error: "Image is too large." }, 413);
    }
    input = inputSchema.parse(JSON.parse(body));
  } catch {
    return json({ error: "Invalid screenshot request." }, 400);
  }
  try {
    // Nothing of the workspace is read here, only the image; the check keeps an
    // unauthenticated caller from spending model calls.
    await verifyContext({
      conversationId: input.conversation_id ?? randomUUID(),
      organizationId: input.organization_id,
      signal: request.signal,
      staff: input.staff,
      userToken,
    });
  } catch {
    return json({ error: "Workspace could not be verified." }, 403);
  }
  const image = Buffer.from(input.image, "base64");
  const mediaType = sniffImage(image);
  if (!mediaType || image.length > MAX_IMAGE_BYTES) {
    return json({ error: "Not a PNG, JPEG, GIF or WebP under 3 MB." }, 400);
  }
  const started = Date.now();
  try {
    const text = renderReading(await read(image, mediaType, request.signal));
    logOpsEvent(
      "widget.screenshot.read",
      {
        conversationId: input.conversation_id,
        message: `${Date.now() - started}ms`,
        outcome: "ok",
      },
      console.info
    );
    return json({ text });
  } catch (error) {
    logOpsEvent(
      "widget.screenshot.read",
      {
        conversationId: input.conversation_id,
        message: `${Date.now() - started}ms: ${error instanceof Error ? error.message : "unknown"}`,
        outcome: "error",
      },
      console.warn
    );
    return json({ error: "Screenshot could not be read." }, 502);
  }
}
