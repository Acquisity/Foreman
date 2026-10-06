import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { verifyWidgetContext } from "./widget-context.js";
import { resolveOwnedIdentifiers } from "./widget-evidence.js";
import {
  assertReplayAllowed,
  LIVE_DIR,
  REPLAY_MISS,
  REPLAY_TICKET,
  replayable,
  replayCase,
  replayRead,
} from "./widget-replay.js";
import { WIDGET_SUPPORT_ISSUER, widgetAuth } from "./widget-scope.js";

const CASE = "evals/widget/cases/eng-14665-paused-campaign-inbox-errors.json";
const recorded = JSON.parse(readFileSync(CASE, "utf8"));
const PRODUCTION = /not allowed on production/;
const FIXTURE_ONLY = /fixture workspace only/;
const LIVE_WORKSPACE_ONLY = /recorded run's workspace only/;
const LIVE_DIR_ONLY = /must be a file in/;
const INVALID_CASE = /Invalid replay case id/;
const SCOPE_UNAVAILABLE = /verified support scope is unavailable/;
const widgetCtx = {
  session: { auth: { initiator: widgetAuth(fixture) } },
} as never;

const withCase = (run: () => Promise<void> | void) => async () => {
  process.env.WIDGET_REPLAY_CASE = CASE;
  try {
    await run();
  } finally {
    process.env.WIDGET_REPLAY_CASE = undefined;
    Reflect.deleteProperty(process.env, "WIDGET_REPLAY_CASE");
  }
};

test("refuses the replay flag on production only", () => {
  assert.throws(
    () =>
      assertReplayAllowed({
        VERCEL_ENV: "production",
        WIDGET_REPLAY_CASE: CASE,
      }),
    PRODUCTION
  );
  assertReplayAllowed({ VERCEL_ENV: "preview", WIDGET_REPLAY_CASE: CASE });
  assertReplayAllowed({ VERCEL_ENV: "production" });
  assert.throws(
    () => assertReplayAllowed({ VERCEL_ENV: "production", WIDGET_REPLAY: "1" }),
    PRODUCTION
  );
});

test(
  "returns the recorded output for the same tool and input, in any key order",
  withCase(() => {
    const [first] = recorded.cassette;
    assert.deepEqual(replayRead(first.tool, first.input), first.output);
    // Recorded with campaignId: null; an omitted field is the same call.
    assert.deepEqual(replayRead(first.tool, {}), first.output);
    const health = recorded.cassette.find(
      (entry: { tool: string }) => entry.tool === "widget_inbox_health"
    );
    assert.deepEqual(replayRead("widget_inbox_health", {}), health.output);
    assert.deepEqual(
      replayRead(first.tool, { extra: undefined, ...first.input }),
      first.output
    );
  })
);

test(
  "a miss returns the fixed result, and an unrecorded ticket files nothing",
  withCase(() => {
    assert.deepEqual(
      replayRead("widget_outreach_health", { campaignId: "other" }),
      REPLAY_MISS
    );
    assert.deepEqual(replayRead("widget_billing_summary", {}), REPLAY_MISS);
    assert.deepEqual(
      replayRead("widget_file_ticket", { summary: "x" }),
      REPLAY_TICKET
    );
  })
);

test(
  "replayable swaps execute only while the flag is set",
  withCase(async () => {
    const tool = defineTool({
      description: "Live read.",
      execute: () => {
        throw new Error("live provider called");
      },
      inputSchema: z.strictObject({}),
    });
    const replayed = replayable("widget_inbox_health", tool);
    assert.notEqual(replayed, tool);
    assert.equal(replayed.description, tool.description);
    assert.deepEqual(
      await replayed.execute({}, widgetCtx),
      recorded.cassette[2].output
    );
    // An issuer without a verified scope reads nothing, as in the authored tool.
    await assert.rejects(
      async () =>
        await replayed.execute({}, {
          session: {
            auth: {
              initiator: { attributes: {}, issuer: WIDGET_SUPPORT_ISSUER },
            },
          },
        } as never),
      SCOPE_UNAVAILABLE
    );
    Reflect.deleteProperty(process.env, "WIDGET_REPLAY_CASE");
    assert.equal(replayable("widget_inbox_health", tool), tool);
  })
);

test(
  "identity answers from the fixture scope without the app",
  withCase(async () => {
    const conversationId = "44444444-4444-4444-8444-444444444444";
    const refuse = () => Promise.reject(new Error("app contacted"));
    const scope = await verifyWidgetContext(
      {
        conversationId,
        organizationId: fixture.organizationId,
        userToken: "replay",
      },
      refuse
    );
    assert.equal(scope.conversationId, conversationId);
    assert.equal(scope.organizationId, fixture.organizationId);
    assert.equal(scope.role, recorded.scope.role);
    await assert.rejects(
      verifyWidgetContext(
        {
          conversationId,
          organizationId: "55555555-5555-4555-8555-555555555555",
          userToken: "replay",
        },
        refuse
      ),
      FIXTURE_ONLY
    );
  })
);

test(
  "ownership owns what the cassette or fixture holds and nothing invented",
  withCase(async () => {
    const recordedId = "00000000-0000-4000-8000-000000000001";
    const invented = "99999999-9999-4999-8999-999999999999";
    const owned = await resolveOwnedIdentifiers(fixture, {
      emails: ["person-1@domain-1.example", "erson-1@domain-1.example"],
      slugs: [
        fixture.organizationSlug,
        "someone-else",
        "fragas-workspace-wMUMT",
      ],
      uuids: [recordedId, invented, fixture.organizationId],
    });
    assert.deepEqual([...owned.uuids], [recordedId, fixture.organizationId]);
    assert.deepEqual(
      [...owned.slugs],
      [fixture.organizationSlug.toLowerCase()]
    );
    assert.deepEqual([...owned.emails], ["person-1@domain-1.example"]);
  })
);

test(
  "lookup applies authored defaults to both sides and ignores object key order",
  withCase(async () => {
    const { widgetGenerationDiagnosticsInput } = await import(
      "../tools/widget_generation_diagnostics.js"
    );
    const directory = mkdtempSync(join(tmpdir(), "widget-replay-input-"));
    const path = join(directory, "case.json");
    const [entry] = recorded.cassette;
    const output = { recorded: true, status: "ok" };
    writeFileSync(
      path,
      JSON.stringify({
        ...recorded,
        cassette: [
          {
            ...entry,
            input: { agent: "copy-review" },
            output,
            tool: "widget_generation_diagnostics",
          },
          // A changed schema must make old inputs miss, never drop the tool.
          {
            ...entry,
            input: { since: "obsolete-window" },
            output,
            tool: "widget_generation_diagnostics",
          },
        ],
      })
    );
    process.env.WIDGET_REPLAY_CASE = path;
    try {
      const replayed = replayable(
        "widget_generation_diagnostics",
        defineTool({
          description: "Diagnostics.",
          execute: () => {
            throw new Error("live provider called");
          },
          inputSchema: widgetGenerationDiagnosticsInput,
        })
      );
      assert.deepEqual(
        replayRead("widget_generation_diagnostics", { agent: "copy-review" }),
        output
      );
      assert.deepEqual(
        replayRead(
          "widget_generation_diagnostics",
          Object.fromEntries([
            ["since", "7d"],
            ["agent", "copy-review"],
          ])
        ),
        output
      );
      assert.deepEqual(
        await replayed.execute(
          { agent: "copy-review", since: "7d" },
          widgetCtx
        ),
        output
      );
      assert.deepEqual(
        await replayed.execute(
          { agent: "copy-review", since: "24h" },
          widgetCtx
        ),
        REPLAY_MISS
      );
      // The inverse case must also hit: explicit default on disk, omitted at execution.
      writeFileSync(
        join(directory, "explicit.json"),
        JSON.stringify({
          ...recorded,
          cassette: [
            {
              ...entry,
              input: { agent: "copy-review", since: "7d" },
              output,
              tool: "widget_generation_diagnostics",
            },
          ],
        })
      );
      process.env.WIDGET_REPLAY_CASE = join(directory, "explicit.json");
      replayable(
        "widget_generation_diagnostics",
        defineTool({
          description: "Diagnostics.",
          execute: () => undefined,
          inputSchema: widgetGenerationDiagnosticsInput,
        })
      );
      assert.deepEqual(
        replayRead("widget_generation_diagnostics", { agent: "copy-review" }),
        output
      );
    } finally {
      process.env.WIDGET_REPLAY_CASE = CASE;
      replayCase();
      rmSync(directory, { force: true, recursive: true });
    }
  })
);

test("request-selected cases stay isolated through session auth and ownership", async () => {
  process.env.WIDGET_REPLAY = "1";
  try {
    const ids = [
      "local-widget-smoke",
      "eng-14665-paused-campaign-inbox-errors",
    ];
    const scopes = await Promise.all(
      ids.map((replayCaseId) =>
        verifyWidgetContext(
          {
            conversationId: fixture.conversationId,
            organizationId: fixture.organizationId,
            replayCaseId,
            userToken: "replay",
          },
          () => Promise.reject(new Error("app contacted"))
        )
      )
    );
    const replayed = replayable(
      "widget_outreach_health",
      defineTool({
        description: "Live read.",
        execute: () => {
          throw new Error("live provider called");
        },
        inputSchema: z.strictObject({ campaignId: z.string().nullable() }),
      })
    );
    await Promise.all(
      scopes.map(async (scope, index) => {
        assert.equal(scope.replayCaseId, ids[index]);
        const entry = replayCase(ids[index]).cassette.find(
          (call) => call.tool === "widget_outreach_health"
        );
        assert.ok(entry);
        assert.deepEqual(
          await replayed.execute(
            entry.input as never,
            { session: { auth: { initiator: widgetAuth(scope) } } } as never
          ),
          entry.output
        );
      })
    );
    // Only the paused-campaign cassette contains this id, so a wrong case cannot own it.
    const onlyInPaused = "00000000-0000-4000-8000-000000000004";
    const owned = await Promise.all(
      scopes.map((scope) =>
        resolveOwnedIdentifiers(scope, {
          emails: [],
          slugs: [],
          uuids: [onlyInPaused],
        })
      )
    );
    assert.deepEqual(
      owned.map((identifiers) => identifiers.uuids.has(onlyInPaused)),
      [false, true]
    );
    await assert.rejects(
      verifyWidgetContext({
        conversationId: fixture.conversationId,
        organizationId: fixture.organizationId,
        replayCaseId: "../../secret",
        userToken: "replay",
      }),
      INVALID_CASE
    );
  } finally {
    Reflect.deleteProperty(process.env, "WIDGET_REPLAY");
  }
});

test("a reworded search replays its recording; a different record still misses", () => {
  const directory = mkdtempSync(join(tmpdir(), "widget-replay-search-"));
  const path = join(directory, "case.json");
  const [entry] = recorded.cassette;
  const first = { issues: [{ title: "first" }] };
  const second = { issues: [{ title: "second" }] };
  const article = { content: "Steps.", url: "https://help.example/a" };
  writeFileSync(
    path,
    JSON.stringify({
      ...recorded,
      cassette: [
        {
          ...entry,
          input: { query: "CRM email won't save" },
          output: first,
          tool: "widget_known_issues",
        },
        {
          ...entry,
          input: { query: "cold email form error" },
          output: second,
          tool: "widget_known_issues",
        },
        {
          ...entry,
          input: { url: "https://help.example/a" },
          output: article,
          tool: "widget_read_help_article",
        },
      ],
    })
  );
  process.env.WIDGET_REPLAY_CASE = path;
  try {
    assert.deepEqual(
      replayRead("widget_known_issues", { query: "cold email form error" }),
      second
    );
    assert.deepEqual(
      replayRead("widget_known_issues", { query: "email not saving in CRM" }),
      first
    );
    assert.deepEqual(
      replayRead("widget_read_help_article", { url: "https://help.example/a" }),
      article
    );
    assert.deepEqual(
      replayRead("widget_read_help_article", { url: "https://help.example/b" }),
      REPLAY_MISS
    );
    assert.deepEqual(
      replayRead("widget_help_article", { query: "csv import" }),
      REPLAY_MISS
    );
  } finally {
    Reflect.deleteProperty(process.env, "WIDGET_REPLAY_CASE");
    rmSync(directory, { force: true, recursive: true });
  }
});

test("live replay answers from the recorded run's real scope, reads live and never files a ticket", async () => {
  const path = `${LIVE_DIR}/test-live-${process.pid}.json`;
  mkdirSync(LIVE_DIR, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      at: "2026-10-05T17:29:22.000Z",
      context: fixture,
      question: "Q",
      runId: "wrun_x",
    })
  );
  process.env.WIDGET_LIVE_CASE = path;
  try {
    assert.throws(
      () =>
        assertReplayAllowed({
          VERCEL_ENV: "production",
          WIDGET_LIVE_CASE: path,
        }),
      PRODUCTION
    );
    const scope = await verifyWidgetContext({
      conversationId: "00000000-0000-4000-8000-0000000000aa",
      organizationId: fixture.organizationId,
      userToken: "live",
    });
    assert.equal(scope.organizationId, fixture.organizationId);
    assert.equal(scope.conversationId, "00000000-0000-4000-8000-0000000000aa");
    await assert.rejects(
      verifyWidgetContext({
        conversationId: "00000000-0000-4000-8000-0000000000aa",
        organizationId: "00000000-0000-4000-8000-0000000000bb",
        userToken: "live",
      }),
      LIVE_WORKSPACE_ONLY
    );
    const authored = defineTool({
      description: "d",
      execute: () => ({ live: true }),
      inputSchema: z.object({}),
    });
    assert.equal(replayable("widget_known_issues", authored), authored);
    const ticket = replayable("widget_file_ticket", authored);
    assert.notEqual(ticket, authored);
    assert.deepEqual(
      await (ticket as { execute: (...args: unknown[]) => unknown }).execute(
        {},
        widgetCtx
      ),
      REPLAY_TICKET
    );
    process.env.WIDGET_LIVE_CASE = "evals/widget/cases/x.json";
    await assert.rejects(
      verifyWidgetContext({
        conversationId: "00000000-0000-4000-8000-0000000000aa",
        organizationId: fixture.organizationId,
        userToken: "live",
      }),
      LIVE_DIR_ONLY
    );
  } finally {
    Reflect.deleteProperty(process.env, "WIDGET_LIVE_CASE");
    rmSync(path, { force: true });
  }
});
