import { z } from "zod";
import { ExecutorError } from "./transport.js";

const bindingSchema = z.object({
  arguments: z.record(z.string(), z.string().max(200)),
  coercions: z
    .record(z.string(), z.enum(["number", "boolean", "single"]))
    .optional(),
  path: z
    .string()
    .max(500)
    .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3,}$/u),
});
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const parts = (path: string): string[] => {
  const keys = path.split(".");
  if (keys.some((key) => !key || forbidden.has(key))) {
    throw new ExecutorError("invalid_binding_argument");
  }
  return keys;
};

/** Deployment-owned exact catalog paths and field mappings, never model input. */
export function bindOperation(
  operation: string,
  source: Record<string, unknown>
) {
  const raw = process.env.EXECUTOR_OPERATION_BINDINGS;
  if (!raw || raw.length > 64_000) {
    throw new ExecutorError("operation_bindings_missing");
  }
  let bindings: Record<string, z.infer<typeof bindingSchema>>;
  try {
    bindings = z.record(z.string(), bindingSchema).parse(JSON.parse(raw));
  } catch (error) {
    throw new Error("Executor operation bindings are invalid.", {
      cause: error,
    });
  }
  const binding = bindings[operation];
  if (!binding || binding.path.startsWith("executor.")) {
    throw new ExecutorError("operation_not_bound");
  }
  const input: Record<string, unknown> = {};
  for (const [target, from] of Object.entries(binding.arguments)) {
    let value = readSource(source, from);
    if (value === undefined) {
      continue;
    }
    value = coerceArgument(value, binding.coercions?.[target]);
    const keys = parts(target);
    let cursor = input;
    for (const key of keys.slice(0, -1)) {
      cursor[key] ??= {};
      if (
        typeof cursor[key] !== "object" ||
        cursor[key] === null ||
        Array.isArray(cursor[key])
      ) {
        throw new ExecutorError("invalid_binding_argument");
      }
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[keys.at(-1) ?? ""] = value;
  }
  return { input, path: binding.path };
}

function readSource(source: Record<string, unknown>, from: string): unknown {
  let value: unknown = source;
  for (const key of parts(from)) {
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/u;
function coerceArgument(
  value: unknown,
  coercion: "number" | "boolean" | "single" | undefined
): unknown {
  if (coercion === "single") {
    if (!Array.isArray(value) || value.length !== 1) {
      throw new ExecutorError("invalid_binding_argument");
    }
    const [single] = value;
    return single;
  }
  if (coercion === "number") {
    if (
      typeof value !== "string" ||
      !DECIMAL.test(value) ||
      !Number.isFinite(Number(value))
    ) {
      throw new ExecutorError("invalid_binding_argument");
    }
    return Number(value);
  }
  if (coercion === "boolean") {
    if (value !== "true" && value !== "false") {
      throw new ExecutorError("invalid_binding_argument");
    }
    return value === "true";
  }
  return value;
}
