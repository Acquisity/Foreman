import assert from "node:assert/strict";
import { it } from "node:test";
import {
  executorOrigin,
  finPreviewEnabled,
  SUPPORT_TOOLKIT,
  toolkitUrl,
} from "./endpoint.js";

it("restricts the default toolkit only in explicitly enabled Preview deployments", () => {
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
      const toolkit = expected ? "foreman-fin-preview" : "foreman";
      assert.equal(
        toolkitUrl(),
        `${executorOrigin()}/mcp/toolkits/${toolkit}?artifacts=false`
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
