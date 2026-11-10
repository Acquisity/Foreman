import { readFile } from "node:fs/promises";
import { z } from "zod";
import { executorOrigin } from "../agent/lib/executor/endpoint.js";
import { REQUIRED_HELPER_OPERATIONS } from "../agent/lib/executor/operations.js";

const root = new URL("../.github/executor/", import.meta.url);
const flagged = ["widget", "support"].find((flag) =>
  process.argv.includes(`--${flag}`)
);
const manifestSchema = z.object({
  toolkit: z.object({
    missing: z.record(z.string(), z.array(z.string())),
    paths: z.array(z.string()),
    slug: z.string(),
  }),
});
const readManifest = async (prefix: string) =>
  manifestSchema.parse(
    JSON.parse(
      await readFile(new URL(`${prefix}toolkit-manifest.json`, root), "utf8")
    )
  );
// The widget runs on the support toolkit (WIDGET_TOOLKIT), so that is the one
// audited; the widget's own catalog only has to be selected inside it.
const audited = flagged === "widget" ? "support" : flagged;
const manifest = await readManifest(audited ? `${audited}-` : "");
const bindings = z
  .record(z.string(), z.object({ path: z.string() }))
  .parse(
    JSON.parse(await readFile(new URL("operation-bindings.json", root), "utf8"))
  );
let failures = 0;
const widget = flagged === "widget" ? await readManifest("widget-") : null;
for (const [provider, missing] of Object.entries(
  widget?.toolkit.missing ?? {}
)) {
  if (missing.length) {
    console.log(
      `MISSING ${widget?.toolkit.slug} widget catalog: ${provider} (${missing.length} coverage gaps)`
    );
    failures += 1;
  }
}
for (const path of widget?.toolkit.paths ?? []) {
  if (!manifest.toolkit.paths.includes(path)) {
    console.log(
      `MISSING widget operation in ${manifest.toolkit.slug}: ${path}`
    );
    failures += 1;
  }
}
for (const operation of REQUIRED_HELPER_OPERATIONS) {
  if (
    !(
      bindings[operation] &&
      manifest.toolkit.paths.includes(bindings[operation].path)
    )
  ) {
    console.log(`MISSING or unselected helper binding: ${operation}`);
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

const inventorySchema = z.object({
  apps: z.array(z.object({ id: z.string(), slug: z.string() })),
});
const toolPageSchema = z.object({
  items: z.array(z.object({ name: z.string() })),
  next: z.string().optional(),
});

// Executor v2 scoped connections are readable only from a signed-in browser,
// so this checks that every selected path names an installed app and tool;
// each connection's app, account and tool selection is checked in the dashboard.
/** One metadata read as the token's owner; never provider credentials or tool calls. */
const readApi = async (
  token: string,
  organization: string,
  path: string
): Promise<unknown> => {
  const response = await fetch(
    `${executorOrigin()}/api/organizations/${encodeURIComponent(organization)}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Executor configuration read failed: HTTP ${response.status}`
    );
  }
  return response.json();
};

if (process.argv.includes("--live")) {
  const token = process.env.EXECUTOR_API_TOKEN;
  const organization = process.env.EXECUTOR_ORGANIZATION;
  if (!(token && organization)) {
    throw new Error(
      "Set EXECUTOR_API_TOKEN to an Executor personal access token and EXECUTOR_ORGANIZATION to the organization ID or slug."
    );
  }
  const api = (path: string) => readApi(token, organization, path);
  const { apps } = inventorySchema.parse(await api("/inventory"));
  const expected = new Map<string, Set<string>>();
  for (const path of manifest.toolkit.paths) {
    const dot = path.indexOf(".");
    const tools = expected.get(path.slice(0, dot)) ?? new Set<string>();
    tools.add(path.slice(dot + 1));
    expected.set(path.slice(0, dot), tools);
  }
  for (const [slug, tools] of expected) {
    const app = apps.find((item) => item.slug === slug);
    if (!app) {
      console.log(`MISSING ${manifest.toolkit.slug}: app ${slug}`);
      failures += 1;
      continue;
    }
    const installed = new Set<string>();
    const seen = new Set<string>();
    const readPage = async (cursor?: string): Promise<void> => {
      // A repeated cursor would page forever; stop and report the app instead.
      if (cursor !== undefined) {
        if (seen.has(cursor)) {
          throw new Error(`Executor repeated a tool page cursor for ${slug}.`);
        }
        seen.add(cursor);
      }
      const page = toolPageSchema.parse(
        await api(
          `/apps/${encodeURIComponent(app.id)}/tools${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
        )
      );
      for (const item of page.items) {
        installed.add(item.name);
      }
      if (page.next) {
        await readPage(page.next);
      }
    };
    // biome-ignore lint/performance/noAwaitInLoops: one app at a time bounds operator API load.
    await readPage();
    const absent = [...tools].filter((tool) => !installed.has(tool));
    console.log(
      `${absent.length ? "FAIL" : "PASS"} ${manifest.toolkit.slug}: ${slug} (${tools.size - absent.length}/${tools.size} tools)`
    );
    for (const tool of absent) {
      console.log(`  missing ${slug}.${tool}`);
    }
    if (absent.length) {
      failures += 1;
    }
  }
}

// Each lane's bot must reach exactly the apps its manifest selects: the
// dispute-write apps only for disputes. Run on an operator machine only; the
// lane tokens are the bots' personal access tokens, never deployment config.
if (process.argv.includes("--isolation")) {
  const organization = process.env.EXECUTOR_ORGANIZATION;
  const lanes = [
    ["foreman", "", process.env.EXECUTOR_LANE_TOKEN_FOREMAN],
    ["foreman-support", "support-", process.env.EXECUTOR_LANE_TOKEN_SUPPORT],
    ["foreman-disputes", "disputes-", process.env.EXECUTOR_LANE_TOKEN_DISPUTES],
  ] as const;
  if (!(organization && lanes.every(([, , token]) => token))) {
    throw new Error(
      "Set EXECUTOR_ORGANIZATION and EXECUTOR_LANE_TOKEN_FOREMAN, _SUPPORT and _DISPUTES to the lane bots' tokens."
    );
  }
  // Three lanes, read together; each result is printed in lane order.
  const results = await Promise.all(
    lanes.map(async ([lane, prefix, token]) => {
      const expected = new Set(
        (await readManifest(prefix)).toolkit.paths.map((path) =>
          path.slice(0, path.indexOf("."))
        )
      );
      const { apps } = inventorySchema.parse(
        await readApi(token as string, organization, "/inventory")
      );
      // Executor's own app is visible to every member and is never called.
      const actual = new Set(
        apps.map((app) => app.slug).filter((slug) => slug !== "executor")
      );
      return {
        absent: [...expected].filter((slug) => !actual.has(slug)),
        extra: [...actual].filter((slug) => !expected.has(slug)),
        lane,
      };
    })
  );
  for (const { absent, extra, lane } of results) {
    console.log(
      `${extra.length || absent.length ? "FAIL" : "PASS"} ${lane} bot reaches exactly its apps`
    );
    for (const slug of extra) {
      console.log(`  unexpected ${slug}`);
    }
    for (const slug of absent) {
      console.log(`  missing ${slug}`);
    }
    if (extra.length || absent.length) {
      failures += 1;
    }
  }
}

console.log(
  `Configuration audit: ${failures} unresolved checks. Live helper, role, requester and attachment acceptance tests are also required.`
);
process.exitCode = failures ? 1 : 0;
