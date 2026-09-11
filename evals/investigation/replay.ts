/** Offline evidence checkpoints. Makes model calls only; no customer/provider tools. */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { generateText, Output } from "ai";
import { z } from "zod";
import { GENERAL_PROMPT } from "../../agent/lib/prompts.js";

const completion =
  "Before another evidence call, identify the unresolved question and the observation that could change your conclusion or next action. Reuse completed checks. Reopen one only for new conflicting evidence or a specific alternative it did not test. When the available checks cannot distinguish the remaining explanations, finish with what is proven, what remains unknown, and the smallest next observation needed. A code defect and the cause of this incident are separate claims. Do not turn a candidate population into a confirmed blast radius. Continue when an available, unexamined source can distinguish a material alternative.";
const baseline = "e01e861f72c6b5b4f50ccd69a6d5cd9fe953a190";
const readBaseline = (path: string) =>
  execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
const skill = readBaseline("agent/skills/triage-investigate/SKILL.md");
const clarify = readBaseline("agent/skills/clarify-with-requester/SKILL.md");
const catalog = readBaseline(
  "agent/skills/triage-investigate/references/tools.md"
);
const cases = [
  {
    evidence:
      "The user requested read-only independent verification of a checkout spinner. Issue, screenshots, comments, duplicates, memory, help, current code and customer state have been reviewed. All relevant evidence lanes are recorded. Current code proves that a resolved checkout error leaves the spinner active. Payment history correlates with reports but is not a proven trigger. Runtime searches by symptom, identity and incident time found no retained request/response. The endpoint did not log that response; provider retention has expired; there is no recording. SDK success, failure and dialog paths were each checked twice with no new conflict. Existing master is current and no fix is deployed. All other relevant sources have been exhausted or marked unavailable. No remaining available query can distinguish a rejected request from a hanging request for this incident.",
    expected: "finish",
    id: "exhausted-evidence",
  },
  {
    evidence:
      "The same code defect is confirmed, but the incident trigger remains unknown. Customer state shows no prior payment; this is correlation. Earlier runtime searches used checkout error text only. A newly read comment identifies an admin impersonating a customer at a precise timestamp. The route rejects billing mutations during impersonation and logs those refusals. An available runtime source has retained the incident window and can be queried by that timestamp and session ID. That source has not been checked on either axis. Other relevant evidence lanes are complete.",
    expected: "read_runtime",
    id: "fresh-discriminating-evidence",
  },
  {
    evidence:
      "An earlier code check used commit A and concluded that resolved errors leave the spinner active. A new verified deployment record shows that production ran commit B during the incident. Its diff changes the checkout callback and error handling. The relevant file at commit B is available but unread. Runtime evidence confirms the symptom without its cause. Other relevant lanes are complete.",
    expected: "read_code",
    id: "new-code-conflict",
  },
];
const output = z.object({
  action: z.enum(["finish", "read_runtime", "read_code", "ask_requester"]),
  incidentCauseProven: z.boolean(),
  reason: z.string(),
});
const [, , destination] = process.argv;
if (!destination) {
  throw new Error("Pass a private JSONL results path.");
}
const repetitions = Number(process.env.REPLAY_REPETITIONS ?? 3);
const tokenLimit = Number(process.env.REPLAY_MAX_OUTPUT ?? 8192);
for (let sample = 0; sample < repetitions; sample += 1) {
  for (const scenario of cases) {
    // Alternate order to avoid always running the candidate against a warmer cache.
    for (const arm of sample % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      const started = Date.now();
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential samples avoid self-induced provider contention.
        const result = await generateText({
          abortSignal: AbortSignal.timeout(90_000),
          instructions: [
            GENERAL_PROMPT,
            skill,
            clarify,
            catalog,
            ...(arm === "candidate" ? [completion] : []),
          ].join("\n\n"),
          maxOutputTokens: tokenLimit,
          maxRetries: 2,
          model: "deepseek/deepseek-v4.1-flash",
          output: Output.object({ schema: output }),
          prompt: `This is an offline evaluation of your next decision with a trusted, synthetic evidence checkpoint. All reads described below have already happened. Do not invoke services or write anything. Choose your next action from the schema; finish means deliver the read-only findings with unknowns and recommended handling, not omit required reporting.\n\n${scenario.evidence}`,
          providerOptions: {
            gateway: { only: [process.env.REPLAY_PROVIDER ?? "deepinfra"] },
          },
        });
        const metrics = {
          arm,
          case: scenario.id,
          elapsedMs: Date.now() - started,
          finishReason: result.finishReason,
          provider: result.providerMetadata,
          reasoning: result.reasoningText,
          sample,
          text: result.text,
          tokenLimit,
          usage: result.usage,
        };
        appendFileSync(`${destination}.raw`, `${JSON.stringify(metrics)}\n`);
        const row = {
          ...metrics,
          output: result.output,
          pass:
            result.output.action === scenario.expected &&
            !result.output.incidentCauseProven,
        };
        appendFileSync(destination, `${JSON.stringify(row)}\n`);
        if (!row.pass) {
          process.exitCode = 1;
        }
        console.log(
          JSON.stringify({
            action: row.output.action,
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
          detail: error instanceof Error ? error.message.slice(0, 400) : "",
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
