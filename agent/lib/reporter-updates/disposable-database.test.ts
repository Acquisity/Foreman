import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { disposableDatabaseUrl } from "./disposable-database.js";

describe("disposableDatabaseUrl", () => {
  it("accepts only the loopback test database", () => {
    for (const url of [
      "postgres://127.0.0.1:55432/foreman_reporter_test",
      "postgres://user:pw@localhost/foreman_reporter_test",
      "postgres://[::1]:5432/foreman_reporter_test",
    ]) {
      assert.equal(disposableDatabaseUrl(url), url);
    }
  });

  it("refuses a remote host, another database name, or nothing at all", () => {
    for (const url of [
      "postgres://db.example.com/foreman_reporter_test",
      "postgres://127.0.0.1:55432/postgres",
      "postgres://127.0.0.1:55432/foreman_reporter_test_backup",
      "postgres://127.0.0.1.example.com/foreman_reporter_test",
      "postgres://localhost/",
      "not a url",
      "",
      undefined,
    ]) {
      assert.throws(() => disposableDatabaseUrl(url), Error, String(url));
    }
  });
});
