import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defineEval } from "eve/evals";

const PAGE_URL = "https://www.selenium.dev/selenium/web/web-form.html";
const READ_FORM =
  "({url:location.href,value:document.querySelector('#my-text-id').value,checked:document.querySelector('#my-check-2').checked})";
const FORM_SNAPSHOT = /Text input[\s\S]*Default checkbox/u;
const IMAGE_DATA = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u;

export default defineEval({
  description:
    "The browser opens Selenium's public test form, reads its snapshot, fills benign text, clicks a checkbox and returns actual screenshot bytes without submitting the form.",
  tags: ["slow", "browser"],
  async test(t) {
    const marker = `Foreman browser smoke ${randomUUID()}`;
    const screenshotPath = `/tmp/foreman-browser-smoke-${randomUUID()}.png`;
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(300_000)]);
    let finished = false;
    try {
      const turn = await t.send(
        `Run this browser compatibility smoke directly using only browser tools. Do not delegate. Make these six calls in order, waiting for each result before the next call. Navigate with browser__navigate to ${PAGE_URL}, then read browser__snapshot. Use browser__fill with clear=true to put exactly ${JSON.stringify(marker)} in #my-text-id. Click the initially unchecked Default checkbox #my-check-2 once with browser__click. Do not submit the form, press Enter, change other fields, or navigate elsewhere. Read back the form with browser__evaluate using exactly this read-only expression: ${READ_FORM}. Capture browser__screenshot with path ${screenshotPath}, fullPage=false and annotate=false. Afterward you may call browser__close once to clean up. Briefly report the observed outcome.`,
        { signal }
      );
      turn.expectOk();
      turn.succeeded();
      turn.noFailedActions();
      assert.equal(turn.inputRequests.length, 0);
      assert.equal(
        turn.events.some((event) => event.type === "subagent.called"),
        false
      );
      turn.requireToolCall("browser__navigate", {
        input: { url: PAGE_URL },
        output: { url: PAGE_URL },
      });
      turn.requireToolCall("browser__snapshot", {
        output: { snapshot: FORM_SNAPSHOT },
      });
      turn.requireToolCall("browser__fill", {
        input: { clear: true, selector: "#my-text-id", text: marker },
      });
      turn.requireToolCall("browser__click", {
        input: { selector: "#my-check-2" },
      });
      turn.requireToolCall("browser__evaluate", {
        input: { expression: READ_FORM },
        output: { result: { checked: true, url: PAGE_URL, value: marker } },
      });
      const screenshot = turn.requireToolCall("browser__screenshot", {
        input: { path: screenshotPath },
        output: { path: screenshotPath },
      });
      // These are actual action.result outputs, not the model's claims or the
      // extension's model-only "already displayed" screenshot placeholder.
      assert.ok(screenshot.output && typeof screenshot.output === "object");
      assert.ok("imageDataUrl" in screenshot.output);
      assert.equal(typeof screenshot.output.imageDataUrl, "string");
      const image = IMAGE_DATA.exec(String(screenshot.output.imageDataUrl));
      assert.ok(image?.[1], "screenshot contains an inline PNG payload");
      const bytes = Buffer.from(image[1], "base64");
      assert.ok(bytes.length > 64 && bytes.length <= 4_194_304);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
      assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
      const toolNames = turn.toolCalls.map((call) => call.name);
      if (toolNames.at(-1) === "browser__close") {
        turn.requireToolCall("browser__close");
        toolNames.pop();
      }
      assert.deepEqual(toolNames, [
        "browser__navigate",
        "browser__snapshot",
        "browser__fill",
        "browser__click",
        "browser__evaluate",
        "browser__screenshot",
      ]);
      t.log(
        `Browser smoke session ${turn.sessionId}: verified form readback and ${bytes.length} PNG bytes. Cold installation and warm snapshot reuse remain separate Preview UAT gates.`
      );
      finished = true;
    } finally {
      if (!finished && t.sessionId) {
        try {
          const response = await t.target.fetch(
            `/eve/v1/session/${encodeURIComponent(t.sessionId)}/cancel`,
            {
              body: JSON.stringify({ tasks: true }),
              headers: { "content-type": "application/json" },
              method: "POST",
              signal: AbortSignal.timeout(10_000),
            }
          );
          if (!response.ok) {
            t.log(
              `Browser smoke cancellation cleanup returned HTTP ${response.status}.`
            );
          }
        } catch {
          t.log(
            "Browser smoke cancellation cleanup failed; inspect this eval session before continuing."
          );
        }
      }
    }
  },
  timeoutMs: 300_000,
});
