import { z } from "zod";
import { ExecutorError } from "./transport.js";

const bindingsSchema = z.record(
  z.string(),
  z.object({
    path: z
      .string()
      .max(500)
      .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3,}$/u),
  })
);

/** Deployment supplies catalog paths only. Arguments are owned by typed source code. */
export function operationPath(operation: string): string {
  const raw = process.env.EXECUTOR_OPERATION_BINDINGS;
  if (!raw || raw.length > 64_000) {
    throw new ExecutorError("operation_bindings_missing");
  }
  let bindings: z.infer<typeof bindingsSchema>;
  try {
    bindings = bindingsSchema.parse(JSON.parse(raw));
  } catch {
    // biome-ignore lint/style/useErrorCause: configuration parser diagnostics can echo deployment values.
    throw new ExecutorError("invalid_operation_bindings");
  }
  const binding = bindings[operation];
  if (!binding || binding.path.startsWith("executor.")) {
    throw new ExecutorError("operation_not_bound");
  }
  return binding.path;
}
