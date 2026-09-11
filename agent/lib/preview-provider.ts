import { z } from "zod";

const providerSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// ENG-13686: root-only serving comparison. Gateway's order keeps its normal
// fallback providers available; the actual serving provider must be read from logs.
export const previewProviderOptions = (
  environment = process.env.VERCEL_ENV,
  provider = process.env.FOREMAN_PREVIEW_PROVIDER
) => {
  if (environment !== "preview" || !provider) {
    return;
  }
  return {
    providerOptions: {
      gateway: { order: [providerSlug.parse(provider)] },
    },
  };
};
