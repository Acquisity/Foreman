import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  type FinProbeResult,
  reportFinProbeToSlack,
} from "./fin-preview-slack.js";

const configureSlack = (
  context: TestContext,
  channel: string | undefined = "C0TESTPREVIEW",
  connector: string | undefined = "slack/test-preview"
) => {
  for (const [name, value] of [
    ["FIN_FOREMAN_PREVIEW_SLACK_CHANNEL", channel],
    ["SLACK_CONNECTOR", connector],
  ]) {
    const previous = process.env[name];
    context.after(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
};

const connected: FinProbeResult = {
  message: "Foreman received this connection test and replied successfully.",
  probe: "probe-1",
  session_id: "test-session",
  status: "connected",
};

type SlackRequest = NonNullable<Parameters<typeof reportFinProbeToSlack>[2]>;

const deferred = <T>() => {
  let resolve: (value: T) => void = () =>
    assert.fail("promise not initialized");
  let reject: (error: Error) => void = () =>
    assert.fail("promise not initialized");
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
};

describe("Fin preview Slack visibility", () => {
  it("posts requested immediately and updates the same message with the observed result", async (context) => {
    configureSlack(context);
    const requests: { method: string; body: Record<string, string> }[] = [];
    const result = deferred<FinProbeResult>();
    const posted = deferred<void>();
    const request: SlackRequest = (method, body) => {
      requests.push({ body, method });
      posted.resolve();
      return Promise.resolve({ ok: true, ts: "123.456" });
    };
    const reporting = reportFinProbeToSlack("probe-1", result.promise, request);
    await posted.promise;
    assert.deepEqual(requests, [
      {
        body: {
          channel: "C0TESTPREVIEW",
          client_msg_id: "probe-1",
          text: "Fin requested a Foreman connection test.\nProbe: probe-1",
          unfurl_links: "false",
          unfurl_media: "false",
        },
        method: "chat.postMessage",
      },
    ]);
    result.resolve(connected);
    await reporting;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      body: {
        channel: "C0TESTPREVIEW",
        text: `Fin → Foreman test: connected\n${connected.message}\nSession: test-session\nProbe: probe-1`,
        ts: "123.456",
      },
      method: "chat.update",
    });
  });

  it("stays disabled when either channel or connector is missing and consumes result rejection", async (context) => {
    configureSlack(context);
    const request: SlackRequest = () =>
      assert.fail("missing configuration must not contact Slack");
    delete process.env.FIN_FOREMAN_PREVIEW_SLACK_CHANNEL;
    await reportFinProbeToSlack(
      "probe-1",
      Promise.reject(new Error("private dispatch error")),
      request
    );
    process.env.FIN_FOREMAN_PREVIEW_SLACK_CHANNEL = "C0TESTPREVIEW";
    delete process.env.SLACK_CONNECTOR;
    await reportFinProbeToSlack("probe-1", Promise.resolve(connected), request);
  });

  it("contains Slack failures and logs no provider error or token", async (context) => {
    configureSlack(context);
    const lines: string[] = [];
    context.mock.method(console, "info", (line: string) => lines.push(line));
    await reportFinProbeToSlack(
      "probe-1",
      Promise.reject(new Error("private dispatch error")),
      () => Promise.reject(new Error("private Slack token"))
    );
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      event: "fin_preview_slack_failed",
      message: "Fin preview Slack notification could not be delivered.",
    });
  });

  it("updates a rejected dispatch with a fixed failure and no fabricated session", async (context) => {
    configureSlack(context);
    const requests: { method: string; body: Record<string, string> }[] = [];
    const result = deferred<FinProbeResult>();
    const slackPost = deferred<{ ok: true; ts: string }>();
    const request: SlackRequest = (method, body) => {
      requests.push({ body, method });
      return slackPost.promise;
    };
    const reporting = reportFinProbeToSlack("probe-1", result.promise, request);
    result.reject(new Error("private model/provider error"));
    // Rejection arrives while the initial Slack request is still pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    slackPost.resolve({ ok: true, ts: "123.456" });
    await reporting;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      body: {
        channel: "C0TESTPREVIEW",
        text: "Fin → Foreman test: failed\nCould not start or observe the connection test.\nProbe: probe-1",
        ts: "123.456",
      },
      method: "chat.update",
    });
  });

  it("reports a pending observation without claiming the run has completed", async (context) => {
    configureSlack(context);
    const texts: string[] = [];
    await reportFinProbeToSlack(
      "probe-1",
      Promise.resolve({
        ...connected,
        message:
          "Foreman accepted the test. Its reply was not received within this connector call.",
        status: "pending",
      }),
      (_method, body) => {
        texts.push(body.text);
        return Promise.resolve({ ok: true, ts: "123.456" });
      }
    );
    assert.equal(texts.length, 2);
    assert.ok(texts[1].includes("test: pending"));
    assert.ok(texts[1].includes("not received within this connector call"));
  });
});
