import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.SUPPORT_CHAT_ENABLED = "true";

const { readScreenshot, receiveWidgetScreenshot, renderReading } = await import(
  "./widget-screenshot.js"
);
const { toWidgetAsk, withScreenshots } = await import(
  "./widget-investigation.js"
);
const { renderAsk } = await import("./widget-router.js");

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.alloc(16, 1),
]);
const ORG = "4f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const reading = {
  error_text: ["Campaign failed to launch"],
  notable: "The Launch button is disabled.",
  screen: "Campaign settings",
  unreadable: [],
};
const post = (body: unknown, token = "tok") =>
  new Request("https://foreman.test/internal/widget/image", {
    body: JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method: "POST",
  });
const verified = () => Promise.resolve({} as never);
const read = () => Promise.resolve(reading);
const LABELLED = /^\[Screenshot the customer attached/u;
const VERBATIM = /"Campaign failed to launch"/u;

describe("widget screenshot route", () => {
  it("reads a verified image into a labelled reading", async () => {
    const response = await receiveWidgetScreenshot(
      post({ image: PNG.toString("base64"), organization_id: ORG }),
      verified,
      read
    );
    assert.equal(response.status, 200);
    const { text } = (await response.json()) as { text: string };
    assert.equal(text, renderReading(reading));
    assert.match(text, LABELLED);
    assert.match(text, VERBATIM);
  });

  it("returns a reading the message route accepts, however long the image model's answer", async () => {
    const long = (length: number) => "x".repeat(length);
    const response = await receiveWidgetScreenshot(
      post({ image: PNG.toString("base64"), organization_id: ORG }),
      verified,
      () =>
        Promise.resolve({
          error_text: Array.from({ length: 6 }, (_, n) => `${n}${long(250)}`),
          notable: long(500),
          screen: long(200),
          unreadable: [long(300), long(300), long(300)],
        })
    );
    const { text } = (await response.json()) as { text: string };
    assert.ok(text.length <= 1500, `${text.length}`);
    assert.equal(text.includes('"3x'), false);
    assert.ok(text.includes('"2x'));
  });

  it("refuses a caller without a token or a verified workspace", async () => {
    const body = { image: PNG.toString("base64"), organization_id: ORG };
    assert.equal(
      (await receiveWidgetScreenshot(post(body, ""), verified, read)).status,
      401
    );
    const denied = () => Promise.reject(new Error("no"));
    assert.equal(
      (await receiveWidgetScreenshot(post(body), denied, read)).status,
      403
    );
  });

  it("refuses bytes that are not an image, and never reads them", async () => {
    let called = false;
    const response = await receiveWidgetScreenshot(
      post({
        image: Buffer.from('{"error":"nope","padding":"x"}').toString("base64"),
        organization_id: ORG,
      }),
      verified,
      () => {
        called = true;
        return Promise.resolve(reading);
      }
    );
    assert.equal(response.status, 400);
    assert.equal(called, false);
  });

  it("reports a failed read so the app sends the message without it", async () => {
    const response = await receiveWidgetScreenshot(
      post({ image: PNG.toString("base64"), organization_id: ORG }),
      verified,
      () => Promise.reject(new Error("model down"))
    );
    assert.equal(response.status, 502);
  });
});

describe("screenshot readings beside the question", () => {
  const shots = ["[Screenshot ...] one", "[Screenshot ...] two"];

  it("keeps them out of the customer's own words at the front door", () => {
    const ask = toWidgetAsk("where is resources?", undefined, shots);
    assert.equal(ask.latest, "where is resources?");
    const rendered = renderAsk(ask);
    assert.ok(rendered.startsWith("LATEST CUSTOMER MESSAGE"));
    assert.ok(
      rendered.indexOf("SCREENSHOTS ATTACHED") >
        rendered.indexOf("where is resources?")
    );
    assert.ok(rendered.includes(shots[1]));
    assert.equal(renderAsk(toWidgetAsk("hi", undefined)), "hi");
  });

  it("stores them joined onto the question for later stages", () => {
    assert.equal(
      withScreenshots({
        action: "start",
        conversation_id: ORG,
        organization_id: ORG,
        question: "why is this failing?",
        screenshots: shots,
      }),
      `why is this failing?\n\n${shots.join("\n\n")}`
    );
  });
});

describe("readScreenshot hedging", () => {
  const later = <T>(ms: number, value: T) =>
    new Promise<T>((resolve) => setTimeout(resolve, ms, value));
  const readingOf = (screen: string) => ({
    error_text: [],
    notable: "",
    screen,
    unreadable: [],
  });

  it("never starts the backup when the first read is quick", async () => {
    const models: string[] = [];
    const result = await readScreenshot(
      PNG,
      "image/png",
      AbortSignal.timeout(10_000),
      (model) => {
        models.push(model);
        return later(10, readingOf(model));
      }
    );
    await later(20, null);
    assert.deepEqual(models, [result.screen]);
  });

  it("answers from the backup when the first read fails", async () => {
    const result = await readScreenshot(
      PNG,
      "image/png",
      AbortSignal.timeout(10_000),
      (model, _image, _type, signal) =>
        model.endsWith("lite")
          ? later(5, readingOf("backup"))
          : new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(new Error("x")));
              setTimeout(() => reject(new Error("stalled")), 5);
            })
    );
    assert.equal(result.screen, "backup");
  });
});

describe("a teammate's screenshot", () => {
  it("is verified as staff against its conversation", async () => {
    let seen: { staff?: boolean; conversationId?: string } = {};
    const response = await receiveWidgetScreenshot(
      post({
        conversation_id: ORG,
        image: PNG.toString("base64"),
        organization_id: ORG,
        staff: true,
      }),
      (input) => {
        seen = input;
        return Promise.resolve({} as never);
      },
      read
    );
    assert.equal(response.status, 200);
    assert.equal(seen.staff, true);
    assert.equal(seen.conversationId, ORG);
  });

  it("is refused without a conversation", async () => {
    const response = await receiveWidgetScreenshot(
      post({
        image: PNG.toString("base64"),
        organization_id: ORG,
        staff: true,
      }),
      verified,
      read
    );
    assert.equal(response.status, 400);
  });
});
