/**
 * A small regression guard behind `.github/OUTSIDE-CALLS.md`.
 *
 * @remarks
 * This is not a TypeScript parser and makes no completeness claim. It knows
 * four literal call spellings, finds each one by name, and reads that call's
 * own argument list by matching parentheses, so a bound removed from one call
 * is caught even when the call beside it keeps one. Everything else is outside
 * what it can see: a call reached through an alias or a variable, a call built
 * inside a template expression, a provider it has never been told about, and
 * the same four spellings written inside a comment or a string.
 *
 * The inventory in `.github/OUTSIDE-CALLS.md` is what records every authored
 * outside call. This only stops the spellings already in the tree from
 * silently losing the bound they have.
 */

/** One call site that carries no bound. */
export interface Violation {
  file: string;
  line: number;
  rule: string;
}

/** What one sweep of a file saw and what it objected to. */
export interface Inspection {
  inspected: number;
  violations: Violation[];
}

/** The only file allowed to call a sandbox `run` directly. */
const DEADLINE_HELPER = "agent/lib/sandbox-deadline.ts";

/** A sandbox command run outside the shared helper, whatever the receiver. */
const SANDBOX_RUN = /(?<=[\w$)\]])\.run\s*\(/gu;

const RULES: Array<{
  /** The bound this call's own argument list has to carry. */
  bound: RegExp;
  /** The call spellings inspected, as a plain identifier call. */
  calls: RegExp;
  /** Files this rule reads, when it is not every file. */
  covers?: (source: string) => boolean;
  rule: string;
}> = [
  {
    bound: /\bsignal\b/u,
    calls: /(?<![\w$.])(?:fetchImpl|fetch)\s*\(/gu,
    rule: "fetch call has no signal",
  },
  {
    bound: /\babortSignal\b/u,
    calls: /(?<![\w$.])(?:head|put|del|get)\s*\(/gu,
    covers: (source) => source.includes('from "@vercel/blob"'),
    rule: "@vercel/blob call has no abortSignal",
  },
  {
    bound: /\bfetchOptions\b[\s\S]*\bsignal\b/u,
    calls: /(?<![\w$.])neon\s*\(/gu,
    rule: "neon client has no fetchOptions signal",
  },
];

/** The text between the parentheses opened at `open`, matched by depth. */
const argumentsAt = (source: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") {
      depth += 1;
    } else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return source.slice(open + 1);
};

/** Every call site in one file that lost its bound. */
export const inspect = (file: string, source: string): Inspection => {
  const violations: Violation[] = [];
  let inspected = 0;
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;
  if (!file.endsWith(DEADLINE_HELPER)) {
    for (const match of source.matchAll(SANDBOX_RUN)) {
      inspected += 1;
      violations.push({
        file,
        line: lineAt(match.index),
        rule: "sandbox command not run through boundedRun",
      });
    }
  }
  for (const { bound, calls, covers, rule } of RULES) {
    if (covers && !covers(source)) {
      continue;
    }
    for (const match of source.matchAll(calls)) {
      inspected += 1;
      const open = match.index + match[0].length - 1;
      if (!bound.test(argumentsAt(source, open))) {
        violations.push({ file, line: lineAt(match.index), rule });
      }
    }
  }
  return { inspected, violations };
};
