import assert from "node:assert/strict";
import { test } from "node:test";
import { readRequestBody } from "./bounded-body.js";

test("a body that stalls past the deadline is unreadable, never returned cut off", async () => {
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"question":"par'));
    },
  });
  const request = new Request("https://foreman.example/", {
    body: stalled,
    duplex: "half",
    method: "POST",
  } as RequestInit);
  await assert.rejects(readRequestBody(request, 50));
});

test("a complete body within the limits is read whole", async () => {
  const request = new Request("https://foreman.example/", {
    body: '{"question":"hi"}',
    method: "POST",
  });
  assert.equal(await readRequestBody(request, 1000), '{"question":"hi"}');
  assert.equal(
    await readRequestBody(
      new Request("https://foreman.example/", {
        body: "x".repeat(10),
        method: "POST",
      }),
      1000,
      5
    ),
    null
  );
});
