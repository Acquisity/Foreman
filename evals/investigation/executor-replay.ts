/** Synthetic cached responses only. No Executor or customer access. */
import { appendFileSync } from "node:fs";
import { generateText, Output } from "ai";
import { z } from "zod";
import { EXECUTOR_DISCOVERY } from "../../agent/lib/executor/instructions.js";

const candidate =
  "Keep the returned result while extracting evidence; do not repeat a provider read merely to change formatting. On success inspect result.data using the described output schema. It may be a direct API object or an MCP result with content text blocks. Parse a text block only when its content is JSON, and inspect the parsed type before using fields. A successful Executor envelope does not turn a provider isError result into evidence. On denial report the gap without another provider call.";
const cases = [
  {
    count: 7,
    error: false,
    id: "mcp",
    result: {
      data: {
        content: [
          {
            text: JSON.stringify({ count: 7, title: "Synthetic checkout" }),
            type: "text",
          },
        ],
      },
      ok: true,
    },
    title: "Synthetic checkout",
  },
  {
    count: 9,
    error: false,
    id: "rest",
    result: { data: { count: 9, title: "Synthetic checkout" }, ok: true },
    title: "Synthetic checkout",
  },
  {
    count: null,
    error: true,
    id: "provider-error",
    result: {
      data: { content: [{ text: "Unavailable", type: "text" }], isError: true },
      ok: true,
    },
    title: null,
  },
  {
    count: null,
    error: true,
    id: "denied",
    result: { error: { code: "denied", status: 403 }, ok: false },
    title: null,
  },
];
const [, , destination] = process.argv;
if (!destination) {
  throw new Error("Pass a private JSONL results path.");
}
for (let sample = 0; sample < 3; sample += 1) {
  for (const scenario of cases) {
    for (const arm of sample % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      const started = Date.now();
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential samples avoid self-induced provider contention.
        const result = await generateText({
          abortSignal: AbortSignal.timeout(60_000),
          instructions:
            EXECUTOR_DISCOVERY + (arm === "candidate" ? `\n${candidate}` : ""),
          maxOutputTokens: 800,
          maxRetries: 2,
          model: "deepseek/deepseek-v4.1-flash",
          output: Output.object({
            schema: z.object({
              count: z.number().nullable(),
              error: z.boolean(),
              repeatProviderRead: z.boolean(),
              title: z.string().nullable(),
            }),
          }),
          prompt: `An Executor read already completed. Extract title and count when available; otherwise use null and mark error. Decide whether another provider call is needed solely to extract those fields. This is a synthetic fixture. Cached result: ${JSON.stringify(scenario.result)}`,
          providerOptions: {
            gateway: { only: [process.env.REPLAY_PROVIDER ?? "deepinfra"] },
          },
        });
        const answer = result.output;
        const row = {
          arm,
          case: scenario.id,
          elapsedMs: Date.now() - started,
          output: answer,
          pass:
            answer.title === scenario.title &&
            answer.count === scenario.count &&
            answer.error === scenario.error &&
            !answer.repeatProviderRead,
          provider: result.providerMetadata,
          sample,
          usage: result.usage,
        };
        appendFileSync(destination, `${JSON.stringify(row)}\n`);
        if (!row.pass) {
          process.exitCode = 1;
        }
        console.log(
          JSON.stringify({
            arm,
            case: row.case,
            elapsedMs: row.elapsedMs,
            pass: row.pass,
            sample,
          })
        );
      } catch (error) {
        const row = {
          arm,
          case: scenario.id,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.name : "unknown",
          failed: true,
          sample,
        };
        appendFileSync(destination, `${JSON.stringify(row)}\n`);
        process.exitCode = 1;
        console.log(JSON.stringify(row));
      }
    }
  }
}
