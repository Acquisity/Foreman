import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.SUPPORT_CHAT_ENABLED = "true";

const { receiveWidgetScreenshot, renderReading } = await import(
  "./widget-screenshot.js"
);
const { withScreenshots } = await import("./widget-investigation.js");

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

describe("withScreenshots", () => {
  it("joins the readings onto the question so every stage reads them", () => {
    const input = withScreenshots({
      action: "start",
      conversation_id: ORG,
      organization_id: ORG,
      question: "why is this failing?",
      screenshots: ["[Screenshot ...] one", "[Screenshot ...] two"],
    });
    assert.equal(
      input.action === "start" && input.question,
      "why is this failing?\n\n[Screenshot ...] one\n\n[Screenshot ...] two"
    );
  });
});
