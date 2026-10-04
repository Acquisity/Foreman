import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  REPLAY_MISS,
  REPLAY_TICKET,
  replayable,
  replayCase,
  replayRead,
} from "./widget-replay.js";

const CASE = "evals/widget/cases/eng-14665-paused-campaign-inbox-errors.json";
const recorded = JSON.parse(readFileSync(CASE, "utf8"));
const PRODUCTION = /not allowed on production/;
const FIXTURE_ONLY = /fixture workspace only/;

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
});

test(
  "returns the recorded output for the same tool and input, in any key order",
  withCase(() => {
    const [first] = recorded.cassette;
    assert.deepEqual(replayRead(first.tool, first.input), first.output);
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
      await replayed.execute({}, {} as never),
      recorded.cassette[2].output
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
          {} as never
        ),
        output
      );
      assert.deepEqual(
        await replayed.execute(
          { agent: "copy-review", since: "24h" },
          {} as never
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
