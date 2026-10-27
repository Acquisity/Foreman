import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

const refuse = (error: string, status: number) =>
  Response.json(
    { error },
    { headers: { "cache-control": "no-store" }, status }
  );

export function diagnosticsSecretRefusal(
  request: Request,
  options: {
    enabled: boolean;
    forbidden: string;
    header: string;
    notConfigured: string;
  },
  env: NodeJS.ProcessEnv = process.env
): Response | null {
  if (!options.enabled) {
    return refuse("Not found.", 404);
  }
  const expected = env.FOREMAN_DIAGNOSTICS_SECRET;
  if (!expected || expected.length < 32) {
    return refuse(options.notConfigured, 503);
  }
  const given = request.headers.get(options.header) ?? "";
  return timingSafeEqual(digest(given), digest(expected))
    ? null
    : refuse(options.forbidden, 403);
}
