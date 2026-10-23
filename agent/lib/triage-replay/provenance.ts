import { words } from "./leakage.js";
import type { ReplayInput } from "./store.js";

const WRITING_COMMAND = />{1,2}\s*[^\s&>]|<<|\btee\b/u;
const LINE_PREFIX = /^(?:[^\s:]+[:-])?\d+[:-]\s?/u;

const normalized = (text: string) => words(text).join(" ");

const TEXT_FIELDS = ["content", "stdout", "stderr"] as const;

const textsOf = (output: unknown): unknown[] => {
  if (typeof output === "string") {
    return [output];
  }
  if (output === null || typeof output !== "object") {
    return [];
  }
  return TEXT_FIELDS.map((field) => (output as Record<string, unknown>)[field]);
};

const outputLines = (output: unknown): string[] =>
  textsOf(output).flatMap((text) =>
    typeof text === "string" ? text.split("\n") : []
  );

export const READ_BACK_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "grep",
  "read_file",
]);

export function ownWrite(toolName: string, input: unknown): string | null {
  const fields = (input ?? {}) as Record<string, unknown>;
  let text: unknown = null;
  if (toolName === "write_file") {
    text = fields.content;
  } else if (
    toolName === "bash" &&
    typeof fields.command === "string" &&
    WRITING_COMMAND.test(fields.command)
  ) {
    text = fields.command;
  }
  const flat = typeof text === "string" ? normalized(text) : "";
  return flat === "" ? null : flat;
}

export function splitOwnWrites(
  written: readonly string[],
  output: unknown
): { generated: string; seeded: string } {
  const own: string[] = [];
  const other: string[] = [];
  const covered = (candidate: string) =>
    candidate !== "" &&
    written.some((text) => ` ${text} `.includes(` ${candidate} `));
  for (const line of outputLines(output)) {
    const whole = normalized(line);
    if (whole === "") {
      continue;
    }
    const stripped = normalized(line.replace(LINE_PREFIX, ""));
    (covered(whole) || covered(stripped) ? own : other).push(line);
  }
  return { generated: own.join("\n"), seeded: other.join("\n") };
}

const fullText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

export function resultInputs(
  written: readonly string[],
  result: {
    asOf: string | null;
    generated: boolean;
    output: unknown;
    source: string;
  }
): ReplayInput[] {
  const own =
    !result.generated &&
    READ_BACK_TOOLS.has(result.source) &&
    written.length > 0
      ? splitOwnWrites(written, result.output)
      : null;
  const parts = own?.generated
    ? [
        { content: own.generated, own: true },
        ...(own.seeded ? [{ content: own.seeded, own: false }] : []),
      ]
    : [{ content: fullText(result.output), own: false }];
  return parts.map((part) => {
    const generated = result.generated || part.own;
    return {
      availableAt: generated ? null : result.asOf,
      content: part.content,
      provenance: generated ? "generated" : "seeded",
      source: result.source,
    };
  });
}
