import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { RequestOptions, request } from "node:https";
import { test } from "node:test";
import {
  isPublicWebsiteAddress,
  readWebsiteHttps,
  readWebsiteNetwork,
} from "./widget-website-network.js";

test("HTTPS keeps the original TLS host, pins the address and stops after response headers", async () => {
  let captured: RequestOptions | undefined;
  let destroyed = false;
  const requester = ((
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void
  ) => {
    captured = options;
    return Object.assign(new EventEmitter(), {
      end: () =>
        onResponse({
          destroy: () => {
            destroyed = true;
          },
          headers: {
            "content-type": "text/html",
            location: "http://127.0.0.1/private?secret=value",
          },
          statusCode: 302,
        } as unknown as IncomingMessage),
    });
  }) as typeof request;
  const result = await readWebsiteHttps(
    "shop.example.com",
    "76.76.21.21",
    new AbortController().signal,
    requester
  );
  assert.equal(captured?.hostname, "shop.example.com");
  assert.equal(captured?.family, 4);
  assert.equal(captured?.agent, false);
  assert.equal(captured?.headers, undefined);
  assert.equal(captured?.path, "/");
  assert.equal(result.redirectHostname, "127.0.0.1");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(destroyed, true);
});

test("public checks reject private, loopback, mapped, multicast and reserved IPs", () => {
  for (const value of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "garbage",
  ]) {
    assert.equal(isPublicWebsiteAddress(value), false, value);
  }
  for (const value of ["76.76.21.21", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicWebsiteAddress(value), true, value);
  }
});

const resolver = (addresses: string[]) => ({
  cancel() {
    /* These fixture lookups complete immediately. */
  },
  resolve4: async () => addresses,
  resolve6: async () => [],
  resolveCname: async () => ["cname.vercel-dns.com"],
  resolveNs: () =>
    Promise.reject(Object.assign(new Error("no NS"), { code: "ENODATA" })),
});

test("HTTP is pinned to the DNS answer and does not follow a reported redirect", async () => {
  const calls: string[][] = [];
  const result = await readWebsiteNetwork(
    "shop.example.com",
    new AbortController().signal,
    resolver(["76.76.21.21"]),
    (domain, address) => {
      calls.push([domain, address]);
      return Promise.resolve({
        redirectHostname: "localhost",
        status: "responded" as const,
        statusCode: 302,
      });
    }
  );
  assert.deepEqual(calls, [["shop.example.com", "76.76.21.21"]]);
  assert.equal(result.http.statusCode, 302);
  assert.equal(result.dns.NS.status, "no_records");
});

test("mixed private DNS never reaches HTTP; DNS failure is not absence", async () => {
  const unexpected = () => {
    throw new Error("HTTP must not be reached");
  };
  const blocked = await readWebsiteNetwork(
    "shop.example.com",
    new AbortController().signal,
    resolver(["76.76.21.21", "127.0.0.1"]),
    unexpected
  );
  assert.equal(blocked.http.status, "blocked_address");
  const failing = {
    ...resolver([]),
    resolve4: () =>
      Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })),
  };
  const result = await readWebsiteNetwork(
    "shop.example.com",
    new AbortController().signal,
    failing,
    unexpected
  );
  assert.equal(result.dns.A.status, "unavailable");
});
