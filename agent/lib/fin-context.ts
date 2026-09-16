import { z } from "zod";
import { INTERCOM_WORKSPACE } from "./acquisity-constants.js";
import { readFinIntercom } from "./executor/dispatch.js";
import {
  type FinContext,
  finAppContextSchema,
  finContextSchema,
} from "./fin-scope.js";
import { providerData } from "./support/conversation.js";

const MAX_CONTEXT_BYTES = 4096;
const WORKSPACE_PATH = /^\/dashboard\/([^/]+)(?:\/|$)/;
const inputSchema = z.object({
  conversationId: z.string().regex(/^\d{1,32}$/),
  userToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_.-]+$/),
});
const organizationSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
const contactId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const conversationSchema = z.object({
  contacts: z.object({
    contacts: z.array(z.object({ id: contactId })).length(1),
    total_count: z.literal(1).optional(),
  }),
  id: z.string().regex(/^\d{1,32}$/),
  source: z.object({
    author: z.object({
      id: contactId,
      type: z.enum(["user", "lead", "contact"]),
    }),
    url: z.string().max(2048),
  }),
});
const contactSchema = z.object({
  external_id: z.uuid(),
  id: contactId,
  workspace_id: z.literal(INTERCOM_WORKSPACE),
});

export type { FinContext } from "./fin-scope.js";

/** Require one configured HTTPS origin before sending it a user's identity token. */
function acquisityOrigin(): string {
  const configured = process.env.ACQUISITY_FIN_ORIGIN;
  const url = configured ? URL.parse(configured) : null;
  if (
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Fin identity verification is not configured.");
  }
  return url.origin;
}

/** Keep the deadline active while consuming a streamed HTTP response. */
async function readContextBody(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > MAX_CONTEXT_BYTES) {
    response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid verified workspace context.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Invalid verified workspace context.");
  }
  const abort = () => reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      // biome-ignore lint/performance/noAwaitInLoops: bound and consume one response stream in order.
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_CONTEXT_BYTES) {
        throw new Error("Invalid verified workspace context.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.cancel().catch(() => undefined);
  }
}

/** Verify the conversation's original workspace; never use current profile or model-selected scope. */
export async function verifyFinContext(
  input: { userToken: string; conversationId: string; signal?: AbortSignal },
  {
    readIntercom = readFinIntercom,
    request = fetch,
  }: {
    readIntercom?: typeof readFinIntercom;
    request?: typeof fetch;
  } = {}
): Promise<FinContext> {
  const parsed = inputSchema.parse(input);
  const origin = acquisityOrigin();
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(50_000)])
    : AbortSignal.timeout(50_000);
  const conversation = conversationSchema.parse(
    providerData(
      await readIntercom("get_conversation", parsed.conversationId, signal)
    )
  );
  if (conversation.id !== parsed.conversationId) {
    throw new Error("Intercom returned a different conversation.");
  }
  const source = URL.parse(conversation.source.url);
  const slug = source?.pathname.match(WORKSPACE_PATH)?.[1];
  if (
    !source ||
    source.origin !== origin ||
    source.username ||
    source.password ||
    !organizationSlug.safeParse(slug).success
  ) {
    throw new Error("The conversation has no verified workspace origin.");
  }
  const [{ id }] = conversation.contacts.contacts;
  if (conversation.source.author.id !== id) {
    throw new Error("The conversation source belongs to a different contact.");
  }
  const contact = contactSchema.parse(
    providerData(await readIntercom("get_contact", id, signal))
  );
  if (contact.id !== id) {
    throw new Error("Intercom returned a different contact.");
  }
  const response = await request(`${origin}/api/internal/foreman/context`, {
    body: JSON.stringify({ organizationSlug: slug }),
    headers: {
      authorization: `Bearer ${parsed.userToken}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal,
  });
  if (response.status !== 200) {
    response.body?.cancel().catch(() => undefined);
    throw new Error("Workspace investigation access could not be verified.");
  }
  const verified = finAppContextSchema.parse(
    await readContextBody(response, signal)
  );
  if (
    verified.userId !== contact.external_id ||
    verified.organizationSlug !== slug
  ) {
    throw new Error(
      "The verified user or workspace does not match this conversation."
    );
  }
  return Object.freeze(
    finContextSchema.parse({
      ...verified,
      contactId: id,
      conversationId: conversation.id,
      origin,
    })
  );
}
