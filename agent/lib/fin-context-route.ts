import { z } from "zod";
import { verifyFinContext } from "./fin-context.js";

const bearer = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;
const inputSchema = z.strictObject({
  conversation_id: z.string().regex(/^\d{1,32}$/),
});
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });

// This endpoint verifies identity only. It never starts or resumes an agent.
export async function receiveFinContext(
  request: Request,
  verifyContext = verifyFinContext
) {
  // Production activation requires a separately approved rollout change.
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.FIN_CONTEXT_ENABLED !== "true"
  ) {
    return json({ error: "Not found." }, 404);
  }
  const token = bearer.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) {
    return json({ error: "Identity required." }, 401);
  }
  let input: z.infer<typeof inputSchema>;
  try {
    const body = await request.text();
    if (body.length > 1024) {
      return json({ error: "Request is too large." }, 413);
    }
    input = inputSchema.parse(JSON.parse(body));
  } catch {
    return json({ error: "Supply the native conversation ID only." }, 400);
  }
  try {
    const context = await verifyContext({
      conversationId: input.conversation_id,
      signal: request.signal,
      userToken: token,
    });
    return json({ context, status: "verified" });
  } catch {
    return json({ error: "Workspace access could not be verified." }, 403);
  }
}
