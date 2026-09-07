/** Domain helpers require an injected transport; production must never fall back to a provider URL. */
export function requiredFetch(request: typeof fetch | undefined): typeof fetch {
  if (!request) {
    throw new Error(
      "Executor transport is required for this provider operation."
    );
  }
  return request;
}
