import { fastCallOptions, MODELS } from "./models.js";
import { logOpsEvent } from "./ops-log.js";

// A single slow provider must not consume the budget for both article selection
// and answer generation. Both providers serve the same configured Gemini model.
const ATTEMPT_MS = 10_000;
type KbModelOptions = ReturnType<typeof fastCallOptions> & {
  providerOptions: { gateway?: { order: string[]; only?: string[] } };
};
export async function withKbModel<T>(
  model: string,
  signal: AbortSignal,
  call: (signal: AbortSignal, options: KbModelOptions) => Promise<T>
): Promise<T> {
  const providers = model === MODELS.kb ? ["vertex", "google"] : [undefined];
  for (const [index, provider] of providers.entries()) {
    signal.throwIfAborted();
    const deadline = provider
      ? AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_MS)])
      : signal;
    const options = fastCallOptions(model);
    const started = Date.now();
    try {
      // biome-ignore lint/performance/noAwaitInLoops: fail over only after the first provider fails or times out.
      return await call(
        deadline,
        provider
          ? {
              ...options,
              providerOptions: {
                ...options.providerOptions,
                gateway: { only: [provider], order: [provider] },
              },
            }
          : options
      );
    } catch (error) {
      if (signal.aborted || index === providers.length - 1) {
        throw error;
      }
      logOpsEvent("widget.kb.provider-fallback", {
        message: `provider=${provider} ms=${Date.now() - started} timeout=${deadline.aborted}`,
        outcome: "retry",
      });
    }
  }
  throw new Error("No knowledge-base model provider available.");
}
