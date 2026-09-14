import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  type FinProbeResult,
  postFinSlackReceipt,
  reportFinProbeToSlack,
  updateFinSlackReceipt,
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
          text: "Fin requested a workspace check. I’ll update this message with the result.",
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
        text: `*Connection test passed*\n\n${connected.message}`,
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
        text: "*Investigation unavailable*\n\nThe check could not be started or its result retrieved.",
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
    assert.ok(texts[1].includes("Investigation still running"));
    assert.ok(texts[1].includes("not received within this connector call"));
  });

  it("updates the same receipt with the completed diagnostic report without publishing its access handle", async (context) => {
    configureSlack(context);
    const requests: { method: string; body: Record<string, string> }[] = [];
    const report =
      "The designated workspace has 42 credits. Source: billing read.";
    await reportFinProbeToSlack(
      "probe-1",
      Promise.resolve({
        ...connected,
        message: report,
        run_handle: "signed-result-access-handle",
        status: "completed",
      }),
      (method, body) => {
        requests.push({ body, method });
        return Promise.resolve({ ok: true, ts: "123.456" });
      }
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "chat.update");
    assert.equal(requests[1].body.ts, "123.456");
    assert.equal(
      requests[1].body.text,
      `*Investigation complete*\n\n${report}`
    );
    assert.ok(
      !JSON.stringify(requests).includes("signed-result-access-handle")
    );
  });
});

describe("durable Fin Slack receipts", () => {
  it("updates the original receipt after restoration, independently of the HTTP observer", async (context) => {
    configureSlack(context);
    const requests: { method: string; body: Record<string, string> }[] = [];
    const request: SlackRequest = (method, body) => {
      requests.push({ body, method });
      return Promise.resolve({ ok: true, ts: "123.456" });
    };
    const receipt = await postFinSlackReceipt("probe-1", request);
    // A later durable event restores state after the initiating request has ended.
    const restored = JSON.parse(JSON.stringify(receipt));
    process.env.FIN_FOREMAN_PREVIEW_SLACK_CHANNEL = "C0DIFFERENT";
    await updateFinSlackReceipt(
      restored,
      {
        message: "The calendar connection needs attention.",
        status: "completed",
      },
      request
    );
    await updateFinSlackReceipt(restored, null, request);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      body: {
        channel: "C0TESTPREVIEW",
        text: "*Investigation complete*\n\nThe calendar connection needs attention.",
        ts: "123.456",
      },
      method: "chat.update",
    });
  });

  it("does not mark a failed Slack delivery as delivered and allows another terminal attempt", async (context) => {
    configureSlack(context);
    context.mock.method(console, "info", () => undefined);
    const receipt = {
      channel: "C0TESTPREVIEW",
      delivered: false,
      ts: "123.456",
    };
    await updateFinSlackReceipt(receipt, null, () =>
      Promise.reject(new Error("unavailable"))
    );
    assert.equal(receipt.delivered, false);
    await updateFinSlackReceipt(
      receipt,
      { message: "No findings are available.", status: "failed" },
      (_method, body) => {
        assert.equal(
          body.text,
          "*Investigation unavailable*\n\nNo findings are available."
        );
        return Promise.resolve({ ok: true, ts: receipt.ts });
      }
    );
    assert.equal(receipt.delivered, true);
  });
});
