import type { EvidenceDeps } from "./dispute-evidence.js";
import type { ProviderClient } from "./executor/operations.js";

const combined = (scope: AbortSignal, caller?: AbortSignal) =>
  caller ? AbortSignal.any([scope, caller]) : scope;

/** Each gather and source owns its timer; all provider calls honor its signal. */
export const withEvidenceDeadline = async <T>(
  deps: EvidenceDeps,
  milliseconds: number,
  read: (scoped: EvidenceDeps) => Promise<T>
): Promise<T> => {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException(
          "The evidence source exceeded its deadline.",
          "TimeoutError"
        )
      ),
    milliseconds
  );
  const signal = combined(deadline.signal, deps.abortSignal);
  const client =
    (provider: ProviderClient): ProviderClient =>
    async (request, options) => {
      const scoped = combined(signal, options?.signal);
      scoped.throwIfAborted();
      const result = await provider(request, { ...options, signal: scoped });
      scoped.throwIfAborted();
      return result;
    };
  const scoped: EvidenceDeps = {
    ...deps,
    abortSignal: signal,
    linear: client(deps.linear),
    read: client(deps.read),
    slack: client(deps.slack),
    sql: async (query, caller) => {
      const querySignal = combined(signal, caller);
      querySignal.throwIfAborted();
      const result = await deps.sql(query, querySignal);
      querySignal.throwIfAborted();
      return result;
    },
  };
  try {
    return await read(scoped);
  } finally {
    clearTimeout(timer);
  }
};
