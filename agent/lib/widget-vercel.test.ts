import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildErrorExcerpt,
  domainConfigSchema,
  type Fetch,
  readVercelLive,
} from "./widget-vercel.js";

const env = {
  ACQUISITY_SUPPORT_VERCEL_TEAM_ID: "team_customersites1",
  ACQUISITY_SUPPORT_VERCEL_TOKEN: "secret-token",
};
const projectId = "prj_customerproject1";
const { signal } = new AbortController();

test("domain diagnostics retain documented recommendations without raw provider fields", () => {
  const config = domainConfigSchema.parse({
    acceptedChallenges: ["dns-01"],
    configuredBy: null,
    misconfigured: true,
    recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com" }],
    recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
    secret: "not returned",
  });
  assert.equal(config.recommendedIPv4?.[0].value[0], "76.76.21.21");
  assert.equal(config.recommendedCNAME?.[0].value, "cname.vercel-dns.com");
  assert.equal("secret" in config, false);
});

const api =
  (accountId: string, seen: { init: RequestInit; url: string }[]): Fetch =>
  (url, init) => {
    seen.push({ init, url });
    const path = new URL(url).pathname;
    let body: unknown = { misconfigured: true };
    if (path === `/v9/projects/${projectId}`) {
      body = { accountId, id: projectId };
    } else if (path === "/v6/deployments") {
      body = {
        deployments: [
          {
            created: 1_790_000_000_000,
            errorCode: "BUILD_FAILED",
            errorMessage: "exit 1",
            readyState: "ERROR",
            target: "production",
          },
        ],
      };
    } else if (path.endsWith("/domains")) {
      body = { domains: [{ name: "shop.example.com", verified: true }] };
    }
    return Promise.resolve(Response.json(body));
  };

test("a live read is GET-only, pinned to the configured team, and reports deployment and domain state", async () => {
  const seen: { init: RequestInit; url: string }[] = [];
  const live = await readVercelLive(
    projectId,
    ["shop.example.com", "other.example.com"],
    signal,
    api(env.ACQUISITY_SUPPORT_VERCEL_TEAM_ID, seen),
    env
  );
  assert.equal(live.status, "live");
  assert.ok(live.status === "live");
  assert.equal(live.deployment?.state, "ERROR");
  assert.deepEqual(
    live.domains.map((d) => [d.domain, d.assignedToProject, d.misconfigured]),
    [
      ["shop.example.com", true, true],
      ["other.example.com", false, true],
    ]
  );
  for (const { init, url } of seen) {
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(new URL(url).host, "api.vercel.com");
    assert.equal(
      new URL(url).searchParams.get("teamId"),
      env.ACQUISITY_SUPPORT_VERCEL_TEAM_ID
    );
    assert.equal(JSON.stringify(live).includes("secret-token"), false);
  }
});

test("a project outside the configured team, an unlinked project, a missing credential and a provider error each stay distinct", async () => {
  const seen: { init: RequestInit; url: string }[] = [];
  assert.deepEqual(
    await readVercelLive(
      projectId,
      [],
      signal,
      api("team_someoneelse123", seen),
      env
    ),
    { status: "inaccessible" }
  );
  // Nothing past the project lookup is read for a project that failed the team check.
  assert.equal(seen.length, 1);
  assert.deepEqual(await readVercelLive(null, [], signal, api("x", []), env), {
    status: "not_linked",
  });
  assert.deepEqual(
    await readVercelLive(projectId, [], signal, api("x", []), {}),
    {
      status: "unavailable",
    }
  );
  // A model-shaped or malformed id never reaches the network.
  const none: { init: RequestInit; url: string }[] = [];
  assert.deepEqual(
    await readVercelLive("../v2/teams", [], signal, api("x", none), env),
    { status: "unavailable" }
  );
  assert.equal(none.length, 0);
  const notFound: Fetch = () =>
    Promise.resolve(new Response("{}", { status: 404 }));
  assert.deepEqual(await readVercelLive(projectId, [], signal, notFound, env), {
    status: "inaccessible",
  });
  const down: Fetch = () =>
    Promise.resolve(new Response("{}", { status: 500 }));
  assert.deepEqual(await readVercelLive(projectId, [], signal, down, env), {
    status: "unavailable",
  });
});

test("the build excerpt starts at the failure, drops colour codes, and is capped", () => {
  const excerpt = buildErrorExcerpt([
    { text: "Installing dependencies" },
    { text: "\u001b[31mFailed to type check.\u001b[0m" },
    { text: "./components/ui/calendar.tsx:87:9" },
    {
      text: "Type error: 'table' does not exist in type 'Partial<ClassNames>'.",
    },
    { text: "x".repeat(5000) },
  ]);
  assert.ok(
    excerpt?.startsWith(
      "Failed to type check.\n./components/ui/calendar.tsx:87:9"
    )
  );
  assert.equal(excerpt?.length, 1500);
  assert.equal(buildErrorExcerpt([{ text: "Build completed" }]), null);
});

test("a build line carried under payload.text is read like a top-level one", () => {
  assert.equal(
    buildErrorExcerpt([
      { payload: { text: "Installing dependencies" } },
      { payload: { text: "Failed to compile." } },
    ]),
    "Failed to compile."
  );
});
