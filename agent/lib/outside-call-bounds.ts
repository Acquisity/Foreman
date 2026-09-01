/**
 * Per-call inspection of Foreman's authored outside calls.
 *
 * @remarks
 * Guards the audit recorded in `.github/OUTSIDE-CALLS.md`: every authored call
 * that leaves the process carries a deadline. This is a source check because
 * the risk is a new call site written without a bound, not the behaviour of a
 * call already written.
 *
 * Each call is located by its own parentheses and each option is read from
 * that call's own argument list, so a bound removed from one call is reported
 * even when a neighbouring call still has one. The repository pins TypeScript
 * 7, whose package entry exposes only `version` and no parser, so the
 * structure is read by masking comments, strings, and regular expressions out
 * of the text and then matching brackets over what is left.
 */

const BLOB_MODULE = "@vercel/blob";
const NEON_MODULE = "@neondatabase/serverless";
/** The one file allowed to call the sandbox `run` primitive directly. */
const SANDBOX_RUN_HELPER = "sandbox-deadline.ts";
const IDENTIFIER_START = /[A-Za-z_$]/u;
const IDENTIFIER_PART = /[\w$]/u;
const WHITESPACE = /\s/u;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu;
/** After one of these, a slash opens a regular expression, never a division. */
const REGEX_PRECEDERS = new Set([
  "",
  "!",
  "&",
  "(",
  ",",
  ":",
  ";",
  "=",
  "?",
  "[",
  "{",
  "|",
]);
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

export type CallClass = "blob" | "fetch" | "neon" | "sandboxRun";

export interface Violation {
  file: string;
  line: number;
  rule: string;
}

export interface Inspection {
  seen: Record<CallClass, number>;
  violations: Violation[];
}

/** One property of an object literal, with where its value starts. */
interface Key {
  name: string;
  valueStart: number | null;
}

/** A span of source text, as half-open offsets. */
interface Span {
  end: number;
  start: number;
}

/** Where a line comment, block comment, string, or regex ends. */
const literalEnd = (text: string, at: number, previous: string): number => {
  const char = text[at] as string;
  const next = text[at + 1];
  if (char === "/" && next === "/") {
    const end = text.indexOf("\n", at);
    return end === -1 ? text.length : end;
  }
  if (char === "/" && next === "*") {
    const end = text.indexOf("*/", at + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (char === '"' || char === "'" || char === "`") {
    let cursor = at + 1;
    while (cursor < text.length && text[cursor] !== char) {
      cursor += text[cursor] === "\\" ? 2 : 1;
    }
    return cursor + 1;
  }
  if (char === "/" && REGEX_PRECEDERS.has(previous)) {
    return regexEnd(text, at);
  }
  return at;
};

/** Where the regular expression opening at `at` ends. */
const regexEnd = (text: string, at: number): number => {
  let cursor = at + 1;
  let inClass = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n" || (char === "/" && !inClass)) {
      break;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    }
    cursor += 1;
  }
  return cursor + 1;
};

/**
 * The source with every comment, string, template, and regular expression
 * blanked to spaces, keeping newlines and every other offset intact.
 */
export const mask = (text: string): string => {
  const out = [...text];
  let index = 0;
  let previous = "";
  while (index < text.length) {
    const stop = literalEnd(text, index, previous);
    if (stop > index) {
      for (let at = index; at < stop && at < out.length; at += 1) {
        if (out[at] !== "\n") {
          out[at] = " ";
        }
      }
      previous = text[index] as string;
      index = stop;
      continue;
    }
    const char = text[index] as string;
    if (!WHITESPACE.test(char)) {
      previous = char;
    }
    index += 1;
  }
  return out.join("");
};

/** How one character changes bracket depth. */
const depthOf = (char: string): number => {
  if (char in OPENERS) {
    return 1;
  }
  return CLOSERS.has(char) ? -1 : 0;
};

/** The index of the bracket closing the one at `open`, or -1. */
const matching = (masked: string, open: number): number => {
  const closer = OPENERS[masked[open] as string];
  if (closer === undefined) {
    return -1;
  }
  let depth = 0;
  for (let at = open; at < masked.length; at += 1) {
    const char = masked[at] as string;
    depth += depthOf(char);
    if (depth === 0 && CLOSERS.has(char)) {
      return char === closer ? at : -1;
    }
  }
  return -1;
};

/** The spans of the top-level arguments of the call opening at `open`. */
const argumentSpans = (masked: string, open: number): Span[] => {
  const close = matching(masked, open);
  if (close === -1) {
    return [];
  }
  const spans: Span[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < close; at += 1) {
    const char = masked[at] as string;
    depth += depthOf(char);
    if (char === "," && depth === 0) {
      spans.push({ end: at, start });
      start = at + 1;
    }
  }
  if (masked.slice(start, close).trim() !== "") {
    spans.push({ end: close, start });
  }
  return spans;
};

/** The index of the object literal an argument span is, or -1. */
const objectAt = (masked: string, span: Span | undefined): number => {
  if (span === undefined) {
    return -1;
  }
  for (let at = span.start; at < span.end; at += 1) {
    const char = masked[at] as string;
    if (WHITESPACE.test(char)) {
      continue;
    }
    return char === "{" ? at : -1;
  }
  return -1;
};

/** The end of the identifier starting at `at`. */
const identifierEnd = (masked: string, at: number, limit: number): number => {
  let end = at + 1;
  while (end < limit && IDENTIFIER_PART.test(masked[end] as string)) {
    end += 1;
  }
  return end;
};

/** The first non-space offset at or after `at`. */
const skipSpace = (masked: string, at: number, limit: number): number => {
  let cursor = at;
  while (cursor < limit && WHITESPACE.test(masked[cursor] as string)) {
    cursor += 1;
  }
  return cursor;
};

/** The property starting at `at`, when the identifier there names one. */
const keyAt = (masked: string, at: number, close: number): Key | null => {
  const end = identifierEnd(masked, at, close);
  const after = skipSpace(masked, end, close);
  const name = masked.slice(at, end);
  if (masked[after] === ":") {
    return { name, valueStart: skipSpace(masked, after + 1, close) };
  }
  if (masked[after] === "," || after >= close) {
    return { name, valueStart: null };
  }
  return null;
};

/** The properties an object literal declares at its own top level. */
const objectKeys = (masked: string, open: number): Key[] => {
  const close = matching(masked, open);
  if (close === -1) {
    return [];
  }
  const keys: Key[] = [];
  let depth = 0;
  let at = open + 1;
  while (at < close) {
    const char = masked[at] as string;
    const delta = depthOf(char);
    if (delta === 0 && depth === 0 && IDENTIFIER_START.test(char)) {
      const end = identifierEnd(masked, at, close);
      const key = keyAt(masked, at, close);
      if (key !== null) {
        keys.push(key);
      }
      at = end;
      continue;
    }
    depth += delta;
    at += 1;
  }
  return keys;
};

/** Whether the argument at `position` is an object literal carrying `name`. */
const carries = (
  masked: string,
  spans: Span[],
  position: number,
  name: string
): boolean => {
  const open = objectAt(masked, spans[position]);
  return (
    open !== -1 && objectKeys(masked, open).some((key) => key.name === name)
  );
};

/** Local names a file imports from `module`. */
const importedFrom = (text: string, module: string): Set<string> => {
  const names = new Set<string>();
  NAMED_IMPORT.lastIndex = 0;
  let match = NAMED_IMPORT.exec(text);
  while (match !== null) {
    if (match[2] === module) {
      for (const entry of (match[1] ?? "").split(",")) {
        const local = entry.split(" as ").at(-1)?.trim();
        if (local) {
          names.add(local);
        }
      }
    }
    match = NAMED_IMPORT.exec(text);
  }
  return names;
};

/** One call site: the callee name, where it starts, and its `(`. */
interface Call {
  name: string;
  open: number;
  start: number;
}

/** Every call in the masked source. */
const calls = (masked: string): Call[] => {
  const found: Call[] = [];
  for (let at = 0; at < masked.length; at += 1) {
    if (masked[at] !== "(") {
      continue;
    }
    let end = at;
    while (end > 0 && WHITESPACE.test(masked[end - 1] as string)) {
      end -= 1;
    }
    let start = end;
    while (start > 0 && IDENTIFIER_PART.test(masked[start - 1] as string)) {
      start -= 1;
    }
    if (start < end && IDENTIFIER_START.test(masked[start] as string)) {
      found.push({ name: masked.slice(start, end), open: at, start });
    }
  }
  return found;
};

/**
 * Whether a call reads `<receiver>.run(`.
 *
 * @remarks
 * The receiver is deliberately not matched by name. Foreman runs sandbox
 * commands nowhere but through `boundedRun`, so any `.run(` written elsewhere
 * under `agent/` is either an unbounded sandbox command or a new kind of call
 * that has to be looked at before this guard is relaxed. Matching a receiver
 * called `sandbox` would let a rename walk straight past the check.
 */
const isSandboxRun = (masked: string, call: Call): boolean =>
  call.name === "run" && masked[call.start - 1] === ".";

/** Whether a Neon client is built with a request deadline. */
const neonIsBounded = (masked: string, spans: Span[]): boolean => {
  const options = objectAt(masked, spans[1]);
  if (options === -1) {
    return false;
  }
  const fetchOptions = objectKeys(masked, options).find(
    (key) => key.name === "fetchOptions"
  );
  const start = fetchOptions?.valueStart ?? null;
  if (start === null || masked[start] !== "{") {
    return false;
  }
  return objectKeys(masked, start).some((key) => key.name === "signal");
};

/**
 * The rule a call of one class breaks, `""` when it is bounded, and `null`
 * when the call is not of that class at all.
 */
type Rule = string | null;

const sandboxRunRule = (file: string, masked: string, call: Call): Rule => {
  if (!isSandboxRun(masked, call)) {
    return null;
  }
  return file.endsWith(SANDBOX_RUN_HELPER)
    ? ""
    : "sandbox command runs outside boundedRun, so it has no deadline";
};

const fetchRule = (masked: string, call: Call, spans: Span[]): Rule => {
  if (call.name !== "fetch" && call.name !== "fetchImpl") {
    return null;
  }
  return carries(masked, spans, 1, "signal") ? "" : "fetch call has no signal";
};

const blobRule = (
  masked: string,
  call: Call,
  spans: Span[],
  operations: ReadonlySet<string>
): Rule => {
  if (!operations.has(call.name)) {
    return null;
  }
  const bounded = spans.some((_span, position) =>
    carries(masked, spans, position, "abortSignal")
  );
  return bounded ? "" : `Blob operation ${call.name} has no abortSignal`;
};

const neonRule = (
  masked: string,
  call: Call,
  spans: Span[],
  clients: ReadonlySet<string>
): Rule => {
  if (!clients.has(call.name)) {
    return null;
  }
  return neonIsBounded(masked, spans)
    ? ""
    : "Neon client has no fetchOptions signal";
};

/**
 * Every unbounded outside call in one authored source file, with a count of
 * the calls of each class that were inspected.
 */
export const inspect = (file: string, text: string): Inspection => {
  const masked = mask(text);
  const blobOperations = importedFrom(text, BLOB_MODULE);
  const neonClients = importedFrom(text, NEON_MODULE);
  const violations: Violation[] = [];
  const seen: Record<CallClass, number> = {
    blob: 0,
    fetch: 0,
    neon: 0,
    sandboxRun: 0,
  };

  for (const call of calls(masked)) {
    const spans = argumentSpans(masked, call.open);
    const rules: [CallClass, Rule][] = [
      ["sandboxRun", sandboxRunRule(file, masked, call)],
      ["fetch", fetchRule(masked, call, spans)],
      ["blob", blobRule(masked, call, spans, blobOperations)],
      ["neon", neonRule(masked, call, spans, neonClients)],
    ];
    for (const [callClass, rule] of rules) {
      if (rule === null) {
        continue;
      }
      seen[callClass] += 1;
      if (rule !== "") {
        violations.push({
          file,
          line: masked.slice(0, call.open).split("\n").length,
          rule,
        });
      }
    }
  }
  return { seen, violations };
};
