import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { executorClient, executorReadQuery } from "../executor/client.js";
import { describeProvider, invokeProvider } from "../executor/dispatch.js";
import { executorTransport } from "../executor/transport.js";
import { GITHUB_TOOL_ALLOWLIST } from "../github/tool-allowlist.js";
import {
  auth,
  CASE_CREATED,
  ctx,
  makeLabel,
  RUN,
  replayHandler,
  replayProcess,
  state,
} from "./fixtures.js";
import { replayMaxSteps, triageReplayHook } from "./hook.js";
import { findLeaks } from "./leakage.js";
import {
  assertTriageReplayAllowed,
  installReplayEgressGuard,
  ReplayEgressError,
} from "./mode.js";
import { replayToolsMiddleware } from "./model.js";
import { buildReplayResult } from "./route.js";
import { triageResultSchema } from "./schema.js";
import {
  REPLAY_SANDBOX_TOOLS,
  REPLAY_TOOL_POLICY,
  replayMayCall,
  replayOutputIsGenerated,
  replayOutputIsSandbox,
} from "./tool-policy.js";

const CANNOT_RUN = /Triage replay cannot run/u;
const EVIDENCE_UNAVAILABLE = /replay_evidence_unavailable/u;
const UNSUPPORTED = /replay_unsupported/u;
const TRANSPORT_BLOCKED = /replay_transport_blocked/u;

describe("replay boot guard", () => {
  it("refuses every combination that could reach real state or newer code", () => {
    for (const extra of [
      { VERCEL_ENV: "production" },
      { WIDGET_REPLAY: "1" },
      { WIDGET_LIVE: "1" },
      { FOREMAN_MEMORY_DATABASE_URL: "postgres://x" },
      { VERCEL_SANDBOX_BASE_SNAPSHOT_ID: "snap_1" },
    ]) {
      assert.throws(
        () => assertTriageReplayAllowed({ TRIAGE_REPLAY: "1", ...extra }),
        CANNOT_RUN
      );
    }
    assert.doesNotThrow(() =>
      assertTriageReplayAllowed({ TRIAGE_REPLAY: "1" })
    );
    assert.doesNotThrow(() =>
      assertTriageReplayAllowed({ VERCEL_ENV: "production" })
    );
  });
});

describe("replay egress wall", () => {
  it("lets only models, Blob, the sandbox control plane and OIDC through", async () => {
    const seen: string[] = [];
    const target = {
      fetch: ((input: string | URL | Request) => {
        seen.push(String(input));
        return Promise.resolve(new Response("ok"));
      }) as typeof fetch,
    };
    installReplayEgressGuard({ TRIAGE_REPLAY: "1" }, target);
    for (const blocked of [
      "https://api.linear.app/graphql",
      "https://api.github.com/repos/Acquisity/Acquisity",
      "https://slack.com/api/chat.postMessage",
      "https://help.acquisity.ai/search",
      "https://api.vercel.com/v6/deployments",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each blocked host is asserted on its own.
      await assert.rejects(target.fetch(blocked), ReplayEgressError);
    }
    for (const allowed of [
      "https://ai-gateway.vercel.sh/v1/chat",
      "https://store.blob.vercel-storage.com/triage-replay/x",
      "https://vercel.com/api/blob/?pathname=x",
      "https://api.vercel.com/v2/sandboxes/abc",
      "https://oidc.vercel.com/token",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each allowed host is asserted on its own.
      await target.fetch(allowed);
    }
    assert.equal(seen.length, 5);
  });
});

describe("replay Executor walls", () => {
  it("records a Linear mutation in the store and reaches no transport", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    const client = executorClient(ctx);
    const result = await client({
      input: { variables: { id: "replay-case", input: { priority: 2 } } },
      operation: "linear.RouteIssueUpdate",
    });
    assert.equal(result.status, 200);
    const s = await state();
    assert.equal(s.writes.at(-1)?.operation, "RouteIssueUpdate");
    assert.equal(s.issue.priority, 2);
  });

  it("fails every production read closed and records the miss", async (t) => {
    await replayProcess(t);
    const result = await executorClient(ctx)({
      input: {
        branch: "main",
        database: "acquisity",
        organization: "acquisity",
        query: "select 1",
      },
      operation: "planetscale.readQuery",
    });
    assert.equal(result.status, 503);
    assert.deepEqual((await state()).evidenceMisses, ["planetscale.readQuery"]);
    await assert.rejects(executorReadQuery(ctx, {}), EVIDENCE_UNAVAILABLE);
  });

  it("refuses any operation through the path dispatcher and the transport", async (t) => {
    await replayProcess(t);
    await assert.rejects(
      invokeProvider(ctx, "linear.org.workspaceLinear.save_issue", {}),
      UNSUPPORTED
    );
    await assert.rejects(
      executorTransport.call(
        { signal: new AbortController().signal, token: "x" },
        "linear.org.workspaceLinear.save_issue",
        {}
      ),
      TRANSPORT_BLOCKED
    );
  });
});

describe("replay tool policy", () => {
  const toolNames = (dir: string) =>
    readdirSync(new URL(dir, import.meta.url))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => f.slice(0, -3));

  it("lists every root and critic tool, so a new one can't slip through", () => {
    const unlisted = [
      ...toolNames("../../tools/"),
      ...toolNames("../../subagents/critic/tools/"),
      ...toolNames("../../subagents/vision/tools/"),
    ].filter(
      (name) => !(name in REPLAY_TOOL_POLICY || name.startsWith("widget_"))
    );
    assert.deepEqual([...new Set(unlisted)], []);
  });

  it("denies widget, GitHub and unknown tools", () => {
    assert.equal(replayMayCall("widget_file_ticket"), false);
    for (const name of GITHUB_TOOL_ALLOWLIST) {
      assert.equal(replayMayCall(name), false);
      assert.equal(replayMayCall(`github__${name}`), false);
    }
    assert.equal(replayMayCall("brand_new_tool"), false);
    assert.equal(replayMayCall("route_ticket"), true);
    assert.equal(replayMayCall("eve__task_wait"), true);
  });
});

describe("replay hook", () => {
  const hookCtx = (cancels: string[]) =>
    ({
      cancel: () => cancels.push("cancel"),
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    }) as never;

  it("cancels the turn when the step budget runs out", async (t) => {
    await replayProcess(t);
    process.env.TRIAGE_REPLAY_MAX_STEPS = "2";
    const cancels: string[] = [];
    const handler = replayHandler("step.started");
    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: steps start one after another.
      await handler({}, hookCtx(cancels));
    }
    assert.equal(replayMaxSteps(), 2);
    assert.deepEqual(cancels, ["cancel"]);
    assert.equal((await state()).cancelled, "step_budget");
  });

  it("cancels the turn on a tool the replay policy denies", async (t) => {
    await replayProcess(t);
    const cancels: string[] = [];
    const handler = replayHandler("actions.requested");
    await handler(
      {
        data: {
          actions: [
            {
              callId: "1",
              input: {},
              kind: "tool-call",
              toolName: "push_branch",
            },
          ],
        },
      },
      hookCtx(cancels)
    );
    assert.deepEqual(cancels, ["cancel"]);
    assert.equal(
      buildReplayResult(await state(), {
        cohortSha256: "0".repeat(64),
        run: 1,
        runId: RUN,
      }).status,
      "boundary_error"
    );
  });
});

describe("replay evidence misses and provider search", () => {
  it("records a miss for every read the Executor walls reject before the typed client", async (t) => {
    await replayProcess(t);
    await assert.rejects(executorReadQuery(ctx, {}), EVIDENCE_UNAVAILABLE);
    await assert.rejects(
      invokeProvider(ctx, "sentry.org.issues.get", {}),
      UNSUPPORTED
    );
    await assert.rejects(
      describeProvider(ctx, "stripe.org.charges.list"),
      UNSUPPORTED
    );
    assert.deepEqual((await state()).evidenceMisses, [
      "planetscale.readQuery",
      "sentry.org.issues.get",
      "stripe.org.charges.list",
    ]);
  });

  it("judges a catalog call by the tool it names", async (t) => {
    await replayProcess(t);
    const cancels: string[] = [];
    const requested = replayHandler("actions.requested");
    const hookCtx = {
      cancel: () => cancels.push("cancel"),
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    };
    await requested(
      {
        data: {
          actions: [
            {
              callId: "w1",
              input: { input: {}, name: "executor__execute" },
              kind: "tool-call",
              toolName: "eve__tool",
            },
          ],
        },
      },
      hookCtx
    );
    assert.deepEqual(cancels, []);
    assert.deepEqual((await state()).evidenceMisses, ["executor__execute"]);
    await requested(
      {
        data: {
          actions: [
            {
              callId: "w2",
              input: { name: "push_branch" },
              kind: "tool-call",
              toolName: "eve__tool",
            },
          ],
        },
      },
      hookCtx
    );
    assert.deepEqual(cancels, ["cancel"]);
  });

  it("records a closed Executor connection call as a miss without cancelling", async (t) => {
    await replayProcess(t);
    const cancels: string[] = [];
    await replayHandler("actions.requested")(
      {
        data: {
          actions: [
            {
              callId: "x1",
              input: { code: "tools.linear.get_issue()" },
              kind: "tool-call",
              toolName: "executor__execute",
            },
          ],
        },
      },
      {
        cancel: () => cancels.push("cancel"),
        session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
      }
    );
    assert.deepEqual(cancels, []);
    assert.deepEqual((await state()).evidenceMisses, ["executor__execute"]);
  });

  it("strips provider-managed tools such as web search before the model call", async () => {
    const params = {
      prompt: [],
      tools: [
        {
          description: "Route a ticket.",
          inputSchema: { type: "object" },
          name: "route_ticket",
          type: "function",
        },
        {
          args: {},
          id: "gateway.exa_search",
          name: "web_search",
          type: "provider",
        },
      ],
    };
    const transformed = await (
      replayToolsMiddleware.transformParams as unknown as (
        o: unknown
      ) => Promise<{
        tools: { name: string }[];
      }>
    )({ model: {}, params, type: "stream" });
    assert.deepEqual(
      transformed.tools.map((tool) => tool.name),
      ["route_ticket"]
    );
  });
});

describe("replay leakage recording", () => {
  it("keeps a long tool result whole, so a fix reference at its end is still scanned", async (t) => {
    await replayProcess(t);
    const tail = "fixed by #6108";
    await replayHandler("action.result")(
      {
        data: {
          result: {
            callId: "g1",
            kind: "tool-result",
            output: `${"x".repeat(30_000)} ${tail}`,
            toolName: "grep",
          },
        },
      },
      {
        cancel: () => undefined,
        session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
      }
    );
    const grep = (await state()).inputs.find(
      (input) => input.source === "grep"
    );
    assert.ok(grep?.content.endsWith(tail));
    assert.equal(grep?.availableAt, CASE_CREATED);
  });

  it("records a vision answer as outside evidence and the critic's as the replay's own", async (t) => {
    await replayProcess(t);
    const result = (subagentName: string) => ({
      data: {
        result: {
          callId: subagentName,
          kind: "subagent-result",
          origin: "child",
          outcome: {},
          output: `${subagentName} says`,
          subagentName,
        },
      },
    });
    const handler = replayHandler("action.result");
    const rootCtx = {
      cancel: () => undefined,
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    };
    await handler(result("vision"), rootCtx);
    await handler(result("critic"), rootCtx);
    const recorded = (await state()).inputs
      .filter((input) => input.source.startsWith("subagent:"))
      .map((input) => [input.source, input.provenance, input.availableAt]);
    assert.deepEqual(recorded, [
      ["subagent:vision", "seeded", null],
      ["subagent:critic", "generated", null],
    ]);
  });

  it("keeps the counts of a failed critic review unknown instead of zero", async (t) => {
    await replayProcess(t);
    const settled = replayHandler("task.settled");
    const rootCtx = {
      cancel: () => undefined,
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    };
    await settled(
      { data: { kind: "agent", name: "critic", status: "failed" } },
      rootCtx
    );
    const failed = (await state()).critic;
    assert.deepEqual(failed, {
      blockingFindings: null,
      failedCriteria: null,
      verdict: "failed",
    });
    const result = buildReplayResult(await state(), {
      cohortSha256: "0".repeat(64),
      run: 1,
      runId: RUN,
    });
    assert.deepEqual(triageResultSchema.parse(result).critic, failed);
  });

  it("records the model's own drafts and decisions as generated, so they never count as leakage", async (t) => {
    await replayProcess(t);
    const phrase =
      "The save handler cleared the cached layout before the panel rendered it again.";
    const handler = replayHandler("action.result");
    const rootCtx = {
      cancel: () => undefined,
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    };
    const own = [
      "check_reply",
      "classify_ask",
      "decide_billing",
      "decide_prior_work",
      "decide_triage",
    ];
    for (const toolName of [...own, "grep"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each result is recorded in turn.
      await handler(
        {
          data: {
            result: {
              callId: toolName,
              kind: "tool-result",
              output: { reply: phrase },
              toolName,
            },
          },
        },
        rootCtx
      );
    }
    const { inputs } = await state();
    assert.deepEqual(
      inputs
        .filter((input) => own.includes(input.source))
        .map((input) => input.provenance),
      own.map(() => "generated")
    );
    assert.equal(
      inputs.find((input) => input.source === "grep")?.provenance,
      "seeded"
    );
    const hits = findLeaks({
      label: makeLabel("ENG-100"),
      result: { inputs: inputs.filter((input) => input.source !== "grep") },
    });
    assert.deepEqual(hits, []);
  });

  it("keeps every sandbox result whole and seeded, whatever the run wrote there", async (t) => {
    await replayProcess(t);
    const phrase =
      "The save handler cleared the cached layout before the panel rendered it again.";
    const rootCtx = {
      cancel: () => undefined,
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    };
    await replayHandler("actions.requested")(
      {
        data: {
          actions: [
            {
              callId: "w1",
              input: { content: phrase, filePath: "/tmp/cause.md" },
              kind: "tool-call",
              toolName: "write_file",
            },
          ],
        },
      },
      rootCtx
    );
    const read = (callId: string, toolName: string, output: unknown) =>
      replayHandler("action.result")(
        { data: { result: { callId, kind: "tool-result", output, toolName } } },
        rootCtx
      );
    await read("r1", "read_file", { content: `1: ${phrase}` });
    await read("r2", "bash", { exitCode: 0, stdout: `${phrase}\n` });
    await read("r3", "grep", { content: `/tmp/cause.md:1:${phrase}` });
    const { inputs } = await state();
    assert.deepEqual(
      inputs
        .filter((input) => ["bash", "grep", "read_file"].includes(input.source))
        .map((input) => [input.source, input.provenance]),
      [
        ["read_file", "seeded"],
        ["bash", "seeded"],
        ["grep", "seeded"],
      ]
    );
    assert.equal(
      inputs.some((input) => input.content.includes(phrase)),
      true
    );
  });

  it("marks exactly the sandbox tools as the ones whose text the scorer checks against the archive", () => {
    assert.deepEqual(
      [...REPLAY_SANDBOX_TOOLS].sort((a, b) => a.localeCompare(b)),
      [
        "bash",
        "checkout_commit",
        "glob",
        "grep",
        "prepare_repository",
        "read_file",
        "read_image",
        "write_file",
      ]
    );
    assert.equal(replayOutputIsSandbox("find_related_issues"), false);
  });

  it("marks exactly the tools that echo the model's own work as generated", () => {
    const generated = Object.keys(REPLAY_TOOL_POLICY)
      .filter((name) => replayOutputIsGenerated(name))
      .sort((a, b) => a.localeCompare(b));
    assert.deepEqual(generated, [
      "check_reply",
      "classify_ask",
      "comment_triage_replay_issue",
      "create_triage_replay_issue",
      "decide_billing",
      "decide_prior_work",
      "decide_triage",
      "list_triage_replay_catalog",
      "read_triage_replay_document",
      "read_triage_replay_issue",
      "record_investigation_case",
      "reply_to_requester",
      "route_ticket",
      "save_investigation_document",
    ]);
  });

  it("keeps a loaded skill's text as a seeded input for the leakage scan", async (t) => {
    await replayProcess(t);
    const handler = replayHandler("action.result");
    await handler(
      {
        data: {
          result: {
            callId: "s1",
            kind: "load-skill-result",
            name: "triage-handling",
            output: "Stage 5 text, fixed by #6108",
          },
        },
      },
      {
        cancel: () => undefined,
        session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
      }
    );
    const skill = (await state()).inputs.find(
      (input) => input.source === "skill:triage-handling"
    );
    assert.equal(skill?.provenance, "seeded");
    assert.ok(skill?.content.includes("#6108"));
  });

  it("fails the run on an image, because a case seeds no image bytes", async (t) => {
    await replayProcess(t);
    const cancels: string[] = [];
    const handler = replayHandler("action.result");
    await handler(
      {
        data: {
          result: {
            callId: "i1",
            kind: "tool-result",
            output: {
              base64: "iVBORw0KGgo=",
              mediaType: "image/png",
              source: "/workspace/shot.png",
            },
            toolName: "read_image",
          },
        },
      },
      {
        cancel: () => cancels.push("cancel"),
        session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
      }
    );
    assert.deepEqual(cancels, ["cancel"]);
    const settled = await state();
    assert.equal(settled.cancelled, "unseeded_image:read_image");
    assert.equal(
      buildReplayResult(settled, {
        cohortSha256: "0".repeat(64),
        run: 1,
        runId: RUN,
      }).status,
      "boundary_error"
    );
  });

  const MEDIA_RESULTS = {
    "a nested content part": {
      type: "content",
      value: [
        { text: "note", type: "text" },
        {
          data: { data: "iVBORw0KGgo=", type: "data" },
          mediaType: "image/jpeg",
          type: "file",
        },
      ],
    },
    "a read_file image": {
      content: "1: (image)",
      file: { height: 10, mediaType: "image/png", size: 2048, width: 10 },
      path: "/workspace/shot.png",
      totalLines: 1,
      truncated: false,
    },
    "a read_file PDF": {
      content: "1: (pdf)",
      file: { mediaType: "application/pdf", pages: 2, size: 4096 },
      path: "/workspace/report.pdf",
      totalLines: 1,
      truncated: false,
    },
  };

  for (const [shape, output] of Object.entries(MEDIA_RESULTS)) {
    it(`fails the run on ${shape}, because eve loads its bytes for the model`, async (t) => {
      await replayProcess(t);
      const cancels: string[] = [];
      const handler = replayHandler("action.result");
      await handler(
        {
          data: {
            result: {
              callId: "m1",
              kind: "tool-result",
              output,
              toolName: "read_file",
            },
          },
        },
        {
          cancel: () => cancels.push("cancel"),
          session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
        }
      );
      assert.deepEqual(cancels, ["cancel"]);
      const settled = await state();
      assert.equal(settled.cancelled, "unseeded_image:read_file");
      assert.equal(
        settled.inputs.filter((input) => input.source === "read_file").length,
        1
      );
      assert.equal(
        buildReplayResult(settled, {
          cohortSha256: "0".repeat(64),
          run: 1,
          runId: RUN,
        }).status,
        "boundary_error"
      );
    });
  }

  it("lets a text read_file through", async (t) => {
    await replayProcess(t);
    const cancels: string[] = [];
    const handler = replayHandler("action.result");
    await handler(
      {
        data: {
          result: {
            callId: "m2",
            kind: "tool-result",
            output: {
              content: "1: hello",
              file: { mediaType: "text/plain", size: 5 },
              path: "/workspace/a.txt",
              totalLines: 1,
              truncated: false,
            },
            toolName: "read_file",
          },
        },
      },
      {
        cancel: () => cancels.push("cancel"),
        session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
      }
    );
    assert.deepEqual(cancels, []);
    assert.equal((await state()).cancelled ?? null, null);
  });

  it("is mounted on vision as well as the root and the critic", async () => {
    const vision = await import(
      "../../subagents/vision/hooks/triage-replay.js"
    );
    assert.equal(vision.default, triageReplayHook);
  });
});
