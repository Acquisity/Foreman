import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const {
  default: tool,
  fetchLinearUpload,
  sniffImage,
} = await import("../subagents/vision/tools/read_image.js");

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.alloc(16, 1),
]);
const NOT_IMAGE = /not a PNG, JPEG, GIF, or WebP image/u;
const EXPIRED_HINT = /expired signed url/u;
const OVER_LIMIT = /over the 3 MiB limit/u;
const HTTP_401 = /HTTP 401 .*unauthorized/u;

describe("vision read_image", () => {
  it("accepts only uploads.linear.app urls or a sandbox path", () => {
    assert.ok(tool.inputSchema instanceof z.ZodType);
    const schema = tool.inputSchema;
    assert.equal(
      schema.safeParse({ url: "https://uploads.linear.app/a/b/c?signature=x" })
        .success,
      true
    );
    assert.equal(
      schema.safeParse({ url: "https://evil.example/a.png" }).success,
      false
    );
    assert.equal(
      schema.safeParse({ url: "http://uploads.linear.app/a/b/c" }).success,
      false
    );
    assert.equal(schema.safeParse({ path: "/tmp/shot.png" }).success, true);
  });

  it("decides the media type from the bytes, not the name", () => {
    assert.equal(sniffImage(PNG), "image/png");
    assert.equal(
      sniffImage(Buffer.from('{"error":"unauthorized","message":"x"}')),
      null
    );
    assert.equal(
      sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])),
      "image/jpeg"
    );
  });

  it("fetches a url with the Linear token and refuses a non-image body with the expiry hint", async () => {
    let header = "";
    const fetchStub: typeof fetch = (_url, init) => {
      header = new Headers(init?.headers).get("Authorization") ?? "";
      return Promise.resolve(
        new Response(new Uint8Array(PNG), { status: 200 })
      );
    };
    const bytes = await fetchLinearUpload(
      "https://uploads.linear.app/a/b/c",
      { token: "lin_app" },
      fetchStub
    );
    assert.equal(header, "Bearer lin_app");
    assert.equal(sniffImage(bytes), "image/png");

    const context = {
      getToken: () => Promise.resolve({ token: "lin_app" }),
    } as unknown as Parameters<typeof tool.execute>[1];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          '{"error":"unauthorized","message":"Please provide authorization header"}',
          { status: 200 }
        )
      )) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          tool.execute(
            { url: "https://uploads.linear.app/a/b/c" },
            context
          ) as Promise<unknown>,
        (error: Error) =>
          NOT_IMAGE.test(error.message) && EXPIRED_HINT.test(error.message)
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("stops reading a url body past 3 MiB even without content-length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let served = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served >= 5) {
          controller.close();
          return;
        }
        served += 1;
        controller.enqueue(chunk);
      },
    });
    await assert.rejects(
      fetchLinearUpload("https://uploads.linear.app/big", { token: "t" }, () =>
        Promise.resolve(new Response(stream, { status: 200 }))
      ),
      OVER_LIMIT
    );
  });

  it("names the status and a body snippet on a non-2xx response", async () => {
    await assert.rejects(
      fetchLinearUpload("https://uploads.linear.app/gone", { token: "t" }, () =>
        Promise.resolve(
          new Response('{"error":"unauthorized"}', { status: 401 })
        )
      ),
      HTTP_401
    );
  });
});
