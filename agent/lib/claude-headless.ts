import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/** Concurrent `claude -p` processes; a replay batch runs up to eight cases at once. */
const JUDGE_CONCURRENCY = 3;

let running = 0;
const queued: (() => void)[] = [];

export async function withClaudeSlot<T>(work: () => Promise<T>): Promise<T> {
  while (running >= JUDGE_CONCURRENCY) {
    // biome-ignore lint/performance/noAwaitInLoops: wait for a free slot.
    await new Promise<void>((resolve) => queued.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    queued.shift()?.();
  }
}

/**
 * `claude -p` with no tools, settings, MCP servers or saved session, the input
 * on stdin and the reply held to the judge schema. Anthropic credentials are
 * stripped so it can only use the local Claude Code login.
 */
export async function runClaudeJson(options: {
  input: string;
  jsonSchema: string;
  model: string;
  signal: AbortSignal;
  system: string;
}): Promise<unknown> {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ]) {
    delete env[key];
  }
  const child = spawn(
    "claude",
    [
      "-p",
      "--model",
      options.model,
      "--system-prompt",
      options.system,
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      options.jsonSchema,
    ],
    {
      cwd: tmpdir(),
      env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const text = Buffer.concat(out).toString("utf8");
  const result = (() => {
    try {
      return JSON.parse(text) as {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
      };
    } catch {
      return null;
    }
  })();
  if (code !== 0 || !result || result.is_error || !result.structured_output) {
    throw new Error(
      `claude -p failed (exit ${code}): ${(result?.result ?? Buffer.concat(err).toString("utf8")).slice(0, 300)}`
    );
  }
  return result.structured_output;
}
