import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { disposableDatabaseUrl } from "./disposable-database.js";

describe("disposableDatabaseUrl", () => {
  it("judges the host and database the pg driver will really use", () => {
    const url =
      "postgres://localhost/foreman_reporter_test?host=db.example.com";
    const effective = new pg.Client({ connectionString: url });
    assert.equal(effective.host, "db.example.com");
    assert.throws(() => disposableDatabaseUrl(url));
  });

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
      "postgres://localhost/foreman_reporter_test?host=db.example.com",
      "postgres://localhost/foreman_reporter_test?hostaddr=10.0.0.5",
      "postgres://localhost/foreman_reporter_test?dbname=production",
      "postgres://localhost/foreman_reporter_test?port=6543",
      "postgres://localhost/foreman_reporter_test?options=-c%20search_path%3Dpublic",
      "postgres:///foreman_reporter_test?host=db.example.com",
      "postgres://localhost/",
      "not a url",
      "",
      undefined,
    ]) {
      assert.throws(() => disposableDatabaseUrl(url), Error, String(url));
    }
  });
});
