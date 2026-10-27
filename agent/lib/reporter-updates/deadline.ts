export class DeadlineError extends Error {
  readonly ms: number;

  constructor(ms: number) {
    super(`Reporter updates step exceeded ${ms} ms.`);
    this.name = "DeadlineError";
    this.ms = ms;
  }
}

export const withDeadline = <T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> => {
  const signal = AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    const expire = () => reject(new DeadlineError(ms));
    signal.addEventListener("abort", expire, { once: true });
    work(signal).then(resolve, reject);
  });
};
