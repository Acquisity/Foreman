import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { REQUIRED_HELPER_OPERATIONS } from "../agent/lib/executor/requests.js";

const root = new URL("../.github/executor/", import.meta.url);
const manifestSchema = z.object({
  toolkit: z.object({
    missing: z.record(z.string(), z.array(z.string())),
    paths: z.array(z.string()),
    slug: z.string(),
  }),
});
const manifest = manifestSchema.parse(
  JSON.parse(await readFile(new URL("toolkit-manifest.json", root), "utf8"))
);
const bindings = z
  .record(z.string(), z.object({ path: z.string() }))
  .parse(
    JSON.parse(await readFile(new URL("operation-bindings.json", root), "utf8"))
  );
let failures = 0;
for (const operation of REQUIRED_HELPER_OPERATIONS) {
  if (!bindings[operation]) {
    console.log(`MISSING helper binding: ${operation}`);
    failures += 1;
  }
}
{
  const { toolkit } = manifest;
  for (const [provider, missing] of Object.entries(toolkit.missing)) {
    if (missing.length) {
      console.log(
        `MISSING ${toolkit.slug}: ${provider} (${missing.length} coverage gaps)`
      );
      failures += 1;
    }
  }
}

const policiesSchema = z.object({
  policies: z.array(
    z.object({ action: z.string(), pattern: z.string(), position: z.string() })
  ),
});
const connectionsSchema = z.object({
  connections: z.array(z.object({ pattern: z.string() })),
});
const toolkitListSchema = z.object({
  toolkits: z.array(
    z.object({ id: z.string(), owner: z.string(), slug: z.string() })
  ),
});

if (process.argv.includes("--live")) {
  const profileName = process.env.EXECUTOR_SETUP_PROFILE;
  if (!profileName) {
    throw new Error(
      "Set EXECUTOR_SETUP_PROFILE to an authenticated official Executor CLI profile."
    );
  }
  const storeSchema = z.object({
    profiles: z.array(
      z.object({
        connection: z.unknown(),
        name: z.string(),
      })
    ),
  });
  const store = storeSchema.parse(
    JSON.parse(
      await readFile(
        join(
          process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor"),
          "server-connections.json"
        ),
        "utf8"
      )
    )
  );
  const selected = store.profiles.find((item) => item.name === profileName);
  const parsed = z
    .object({
      apiBaseUrl: z.literal("https://executor.acquisity.ai/api"),
      auth: z.object({ accessToken: z.string().min(1) }),
    })
    .safeParse(selected?.connection);
  if (!parsed.success) {
    throw new Error("Expected the Acquisity Executor account profile.");
  }
  const setupConnection = parsed.data;
  const api = async (path: string): Promise<unknown> => {
    const response = await fetch(`${setupConnection.apiBaseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${setupConnection.auth.accessToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(
        `Executor configuration read failed: HTTP ${response.status}`
      );
    }
    return response.json();
  };
  const installed = toolkitListSchema.parse(await api("/toolkits")).toolkits;
  for (const expected of [manifest.toolkit]) {
    const actual = installed.find((item) => item.slug === expected.slug);
    if (actual?.owner !== "user") {
      console.log(
        `FAIL ${expected.slug}: expected the shared-account personal toolkit`
      );
      failures += 1;
      continue;
    }
    // These are independent metadata reads; no operations or credentials are returned.
    // biome-ignore lint/performance/noAwaitInLoops: bound operator API load to two concurrent requests.
    const [policyData, connectionData] = await Promise.all([
      api(`/toolkits/${actual.id}/policies`),
      api(`/toolkits/${actual.id}/connections`),
    ]);
    const { policies } = policiesSchema.parse(policyData);
    const { connections } = connectionsSchema.parse(connectionData);
    const approved = policies.filter((rule) => rule.action === "approve");
    const denied = policies.filter(
      (rule) => rule.action === "block" && rule.pattern === "*"
    );
    const prefixes = new Set(
      expected.paths.map((path) => `${path.split(".").slice(0, 3).join(".")}.*`)
    );
    const valid =
      approved.length === expected.paths.length &&
      approved.every((rule) => expected.paths.includes(rule.pattern)) &&
      new Set(approved.map((rule) => rule.pattern)).size === approved.length &&
      denied.length === 1 &&
      policies.length === approved.length + 1 &&
      approved.every((rule) => rule.position < denied[0].position) &&
      connections.length === prefixes.size &&
      connections.every((connection) => prefixes.has(connection.pattern));
    console.log(
      `${valid ? "PASS" : "FAIL"} ${expected.slug}: exact catalog and default-deny policy`
    );
    if (!valid) {
      failures += 1;
    }
  }
}
console.log(
  `Configuration audit: ${failures} unresolved checks. Live helper, role, requester and attachment acceptance tests are also required.`
);
process.exitCode = failures ? 1 : 0;
