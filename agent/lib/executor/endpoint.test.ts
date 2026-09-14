import assert from "node:assert/strict";
import { it } from "node:test";
import {
  executorOrigin,
  FIN_PREVIEW_TOOLKIT,
  finPreviewEnabled,
  SUPPORT_TOOLKIT,
  toolkitUrl,
} from "./endpoint.js";

it("keeps the normal default toolkit when Fin Preview is enabled", () => {
  const previous = {
    FIN_FOREMAN_PREVIEW_ENABLED: process.env.FIN_FOREMAN_PREVIEW_ENABLED,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  const scenarios = [
    { enabled: "true", environment: "preview", expected: true },
    { enabled: "false", environment: "preview", expected: false },
    { enabled: undefined, environment: "preview", expected: false },
    { enabled: "true", environment: "production", expected: false },
    { enabled: "true", environment: "development", expected: false },
    { enabled: "true", environment: undefined, expected: false },
  ];
  try {
    for (const { enabled, environment, expected } of scenarios) {
      if (enabled === undefined) {
        delete process.env.FIN_FOREMAN_PREVIEW_ENABLED;
      } else {
        process.env.FIN_FOREMAN_PREVIEW_ENABLED = enabled;
      }
      if (environment === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = environment;
      }
      assert.equal(finPreviewEnabled(), expected);
      assert.equal(
        toolkitUrl(),
        `${executorOrigin()}/mcp/toolkits/foreman?artifacts=false`
      );
      assert.equal(
        toolkitUrl(FIN_PREVIEW_TOOLKIT),
        `${executorOrigin()}/mcp/toolkits/foreman-fin-preview?artifacts=false`
      );
      assert.equal(
        toolkitUrl(SUPPORT_TOOLKIT),
        `${executorOrigin()}/mcp/toolkits/foreman-support?artifacts=false`
      );
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
