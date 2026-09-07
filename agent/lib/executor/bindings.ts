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
  const binding = bindingsSchema.parse(JSON.parse(raw))[operation];
  if (!binding || binding.path.startsWith("executor.")) {
    throw new ExecutorError("operation_not_bound");
  }
  return binding.path;
}
