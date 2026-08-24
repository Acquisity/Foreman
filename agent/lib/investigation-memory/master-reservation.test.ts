import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  causalFingerprint,
  completeMasterReservation,
  type ReservationDatabase,
  reserveMaster as reserveMasterRecord,
} from "./master-reservation.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planetscale/test";

const [
  { default: completeReservation, readLinearMasterCreatedAt },
  { default: reserveMaster, publicReservationErrorMessage },
] = await Promise.all([
  import("../../tools/complete_triage_master_reservation.js"),
  import("../../tools/reserve_triage_master.js"),
]);

const causalIdentity = {
  causalPathKeys: ["scheduler#dispatch-campaign", "provider#send"],
  failingInvariantKey: "campaign.dispatch.exactly-once",
  preventionOutcomeKey: "provider.request.exactly-one",
  repositoryKey: "acquisity/acquisity",
  triggerConditionKeys: ["campaign.due", "sending-window.open"],
};

const STALE_PREDECESSOR_ERROR =
  /reviewed predecessor is not more than 30 days old/u;

const reservationInput = {
  approvalId: `trv_${"a".repeat(64)}_0ae59086-e924-42d1-b7ff-f9c750a2a7c9`,
  causalIdentity,
  eligibilityEvaluatedAt: "2026-08-24T12:00:00.000Z",
  evidenceRevision: "a".repeat(64),
  generationKey: "initial",
  masterRecencyPolicy: "UNBOUNDED" as const,
  reviewAttempt: 1 as const,
  reviewerModel: "openai/gpt-5.6-sol",
  sourceIssueId: "ENG-123",
};

const fakeReservationDatabase = (): ReservationDatabase => {
  let row:
    | {
        causal_fingerprint: string;
        evidence_revision: string;
        generation_key: string;
        id: string;
        master_created_at: string | null;
        master_issue_id: string | null;
        source_issue_id: string;
        status: "reserved" | "complete";
        updated_at: string;
      }
    | undefined;
  return {
    async query(statement, params = []) {
      await Promise.resolve();
      if (statement.includes("INSERT INTO triage_master_reservations")) {
        if (row) {
          return [];
        }
        row = {
          causal_fingerprint: String(params[2]),
          evidence_revision: String(params[5]),
          generation_key: String(params[8]),
          id: String(params[0]),
          master_created_at: null,
          master_issue_id: null,
          source_issue_id: String(params[3]),
          status: "reserved" as const,
          updated_at: String(params[10]),
        };
        return [{ id: row.id }];
      }
      if (statement.includes("SELECT id, causal_fingerprint")) {
        return row ? [row] : [];
      }
      if (statement.includes("SET id = $1")) {
        if (
          row?.status !== "complete" ||
          row.master_issue_id !== params[8] ||
          row.master_created_at === null ||
          Date.parse(row.master_created_at) >=
            Date.parse(String(params[10])) - 30 * 24 * 60 * 60 * 1000
        ) {
          return [];
        }
        row = {
          causal_fingerprint: String(params[2]),
          evidence_revision: String(params[5]),
          generation_key: String(params[8]),
          id: String(params[0]),
          master_created_at: null,
          master_issue_id: null,
          source_issue_id: String(params[3]),
          status: "reserved",
          updated_at: String(params[10]),
        };
        return [{ id: row.id }];
      }
      if (statement.includes("SET master_issue_id = $1")) {
        const current = row;
        if (current === undefined) {
          return [];
        }
        if (
          current.id !== params[3] ||
          current.source_issue_id !== params[4] ||
          current.status !== "reserved" ||
          !Number.isFinite(Date.parse(String(params[1]))) ||
          Date.parse(String(params[1])) <
            Date.parse(current.updated_at) - 5 * 60 * 1000 ||
          Date.parse(String(params[1])) >
            Date.parse(current.updated_at) + 60 * 1000
        ) {
          return [];
        }
        current.master_issue_id = String(params[0]);
        current.master_created_at = String(params[1]);
        current.status = "complete";
        return [{ id: current.id }];
      }
      throw new Error("Unexpected reservation query in test.");
    },
  };
};

describe("causalFingerprint", () => {
  it("canonicalizes key order but not causal identity", () => {
    const base = causalIdentity;
    assert.equal(
      causalFingerprint(base),
      causalFingerprint({
        ...base,
        causalPathKeys: [...base.causalPathKeys].reverse(),
        triggerConditionKeys: [...base.triggerConditionKeys].reverse(),
      })
    );
    assert.notEqual(
      causalFingerprint(base),
      causalFingerprint({
        ...base,
        causalPathKeys: ["provider-webhook#ingest-reply"],
      })
    );
  });
});

describe("causal master reservation concurrency", () => {
  it("authorizes only the insert winner and fails retries closed", async () => {
    const database = fakeReservationDatabase();
    const [first, concurrent] = await Promise.all([
      reserveMasterRecord(reservationInput, database),
      reserveMasterRecord(reservationInput, database),
    ]);
    const results = [first, concurrent];
    assert.equal(results.filter(({ acquired }) => acquired).length, 1);
    assert.equal(
      results.filter(
        (result) =>
          !result.acquired && result.reason === "reservation_in_progress"
      ).length,
      1
    );

    const retry = await reserveMasterRecord(reservationInput, database);
    assert.deepEqual(retry, {
      acquired: false,
      causalFingerprint: causalFingerprint(causalIdentity),
      reason: "reservation_in_progress",
    });
  });

  it("never reopens the external-create crash gap", async () => {
    const database = fakeReservationDatabase();
    const reserved = await reserveMasterRecord(reservationInput, database);
    assert.equal(reserved.acquired, true);

    const afterUnconfirmedCreate = await reserveMasterRecord(
      reservationInput,
      database
    );
    assert.equal(afterUnconfirmedCreate.acquired, false);
    assert.equal(afterUnconfirmedCreate.reason, "reservation_in_progress");
  });

  it("returns the completed master after binding", async () => {
    const database = fakeReservationDatabase();
    const reserved = await reserveMasterRecord(reservationInput, database);
    assert.equal(reserved.acquired, true);
    if (!reserved.acquired) {
      return;
    }
    assert.equal(
      await completeMasterReservation(
        reserved.reservationId,
        "ENG-123",
        "ENG-999",
        "2026-08-24T12:00:00.000Z",
        database
      ),
      true
    );
    assert.deepEqual(await reserveMasterRecord(reservationInput, database), {
      acquired: false,
      causalFingerprint: causalFingerprint(causalIdentity),
      existingMasterCreatedAt: "2026-08-24T12:00:00.000Z",
      existingMasterIssueId: "ENG-999",
      reason: "existing_master",
    });
  });

  it("binds completion only to the source stored on the reservation", async () => {
    const database = fakeReservationDatabase();
    const reserved = await reserveMasterRecord(reservationInput, database);
    assert.equal(reserved.acquired, true);
    if (!reserved.acquired) {
      return;
    }
    assert.equal(
      await completeMasterReservation(
        reserved.reservationId,
        "ENG-124",
        "ENG-999",
        "2026-08-24T12:00:00.000Z",
        database
      ),
      false
    );
  });

  it("mirrors the database completion timestamp window", async () => {
    const database = fakeReservationDatabase();
    const reserved = await reserveMasterRecord(reservationInput, database);
    assert.equal(reserved.acquired, true);
    if (!reserved.acquired) {
      return;
    }
    assert.equal(
      await completeMasterReservation(
        reserved.reservationId,
        "ENG-123",
        "ENG-999",
        "2026-08-24T11:54:59.000Z",
        database
      ),
      false
    );
    assert.equal(
      await completeMasterReservation(
        reserved.reservationId,
        "ENG-123",
        "ENG-999",
        "2026-08-24T12:01:01.000Z",
        database
      ),
      false
    );
  });

  it("permits one reviewed new generation after a stale master", async () => {
    const database = fakeReservationDatabase();
    const first = await reserveMasterRecord(
      {
        ...reservationInput,
        eligibilityEvaluatedAt: "2026-07-01T00:00:00.000Z",
      },
      database
    );
    assert.equal(first.acquired, true);
    if (!first.acquired) {
      return;
    }
    assert.equal(
      await completeMasterReservation(
        first.reservationId,
        "ENG-123",
        "ENG-999",
        "2026-07-01T00:00:00.000Z",
        database
      ),
      true
    );
    const nextInput = {
      ...reservationInput,
      generationKey: "ENG-999",
      masterRecencyPolicy: "THIRTY_DAY" as const,
      predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
    };
    const [next, concurrent] = await Promise.all([
      reserveMasterRecord(nextInput, database),
      reserveMasterRecord(nextInput, database),
    ]);
    assert.equal(
      [next, concurrent].filter(({ acquired }) => acquired).length,
      1
    );
  });

  it("cannot advance from an uncompleted or different predecessor", async () => {
    const database = fakeReservationDatabase();
    assert.equal(
      (await reserveMasterRecord(reservationInput, database)).acquired,
      true
    );
    const attempted = await reserveMasterRecord(
      {
        ...reservationInput,
        generationKey: "ENG-888",
        masterRecencyPolicy: "THIRTY_DAY",
        predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
      },
      database
    );
    assert.equal(attempted.acquired, false);
    assert.equal(attempted.reason, "reservation_in_progress");
  });

  it("serializes different stale predecessor claims through one causal head", async () => {
    const database = fakeReservationDatabase();
    const first = await reserveMasterRecord(
      {
        ...reservationInput,
        eligibilityEvaluatedAt: "2026-07-01T00:00:00.000Z",
      },
      database
    );
    assert.equal(first.acquired, true);
    if (!first.acquired) {
      return;
    }
    await completeMasterReservation(
      first.reservationId,
      "ENG-123",
      "ENG-999",
      "2026-07-01T00:00:00.000Z",
      database
    );
    const results = await Promise.all([
      reserveMasterRecord(
        {
          ...reservationInput,
          generationKey: "ENG-999",
          masterRecencyPolicy: "THIRTY_DAY",
          predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
        },
        database
      ),
      reserveMasterRecord(
        {
          ...reservationInput,
          generationKey: "ENG-888",
          masterRecencyPolicy: "THIRTY_DAY",
          predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
        },
        database
      ),
    ]);
    assert.equal(results.filter(({ acquired }) => acquired).length, 1);
  });

  it("bootstraps one head from a reviewed stale master predating the table", async () => {
    const database = fakeReservationDatabase();
    const staleBootstrap = {
      ...reservationInput,
      generationKey: "ENG-777",
      masterRecencyPolicy: "THIRTY_DAY" as const,
      predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
    };
    const [first, concurrent] = await Promise.all([
      reserveMasterRecord(staleBootstrap, database),
      reserveMasterRecord(staleBootstrap, database),
    ]);
    assert.equal(
      [first, concurrent].filter(({ acquired }) => acquired).length,
      1
    );
  });

  it("rejects invalid predecessor timestamps before querying storage", async () => {
    const database: ReservationDatabase = {
      query() {
        assert.fail("invalid timestamps must not reach storage");
      },
    };
    await assert.rejects(
      reserveMasterRecord(
        {
          ...reservationInput,
          generationKey: "ENG-777",
          masterRecencyPolicy: "THIRTY_DAY",
          predecessorCreatedAt: "not-a-timestamp",
        },
        database
      ),
      STALE_PREDECESSOR_ERROR
    );
  });

  it("fails closed when the persisted head belongs to another reviewed generation", async () => {
    const database = fakeReservationDatabase();
    const first = await reserveMasterRecord(
      {
        ...reservationInput,
        eligibilityEvaluatedAt: "2026-07-01T00:00:00.000Z",
      },
      database
    );
    assert.equal(first.acquired, true);
    if (!first.acquired) {
      return;
    }
    assert.equal(
      await completeMasterReservation(
        first.reservationId,
        "ENG-123",
        "ENG-999",
        "2026-07-01T00:00:00.000Z",
        database
      ),
      true
    );
    const advanced = await reserveMasterRecord(
      {
        ...reservationInput,
        generationKey: "ENG-999",
        masterRecencyPolicy: "THIRTY_DAY",
        predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
      },
      database
    );
    assert.equal(advanced.acquired, true);
    if (!advanced.acquired) {
      return;
    }
    assert.equal(
      await completeMasterReservation(
        advanced.reservationId,
        "ENG-123",
        "ENG-1000",
        "2026-08-24T12:00:00.000Z",
        database
      ),
      true
    );
    assert.deepEqual(
      await reserveMasterRecord(
        {
          ...reservationInput,
          generationKey: "ENG-888",
          masterRecencyPolicy: "THIRTY_DAY",
          predecessorCreatedAt: "2026-07-01T00:00:00.000Z",
        },
        database
      ),
      {
        acquired: false,
        causalFingerprint: causalFingerprint(causalIdentity),
        reason: "reviewed_generation_changed",
      }
    );
  });
});

describe("causal master reservation tools", () => {
  it("returns only deliberate policy errors to the agent", () => {
    assert.equal(
      publicReservationErrorMessage(
        new Error("Only 30-day intake may advance a stale master generation.")
      ),
      "Only 30-day intake may advance a stale master generation."
    );
    assert.equal(
      publicReservationErrorMessage(
        new Error("postgres://user:secret@private-host/database")
      ),
      "The causal reservation is unavailable."
    );
  });

  it("stores opaque critic approvals as constrained text", () => {
    const migration = readFileSync(
      new URL(
        "../../../migrations/0002_triage_master_reservations.sql",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(migration.includes("critic_approval_id text NOT NULL"));
    assert.ok(migration.includes("critic_approval_id ~ '^trv_"));
    assert.ok(
      migration.includes("triage_master_reservations_state_fields_check")
    );
    assert.ok(
      migration.includes(
        "status = 'reserved' AND master_issue_id IS NULL AND master_created_at IS NULL"
      )
    );
    assert.ok(
      migration.includes(
        "status = 'complete' AND master_issue_id IS NOT NULL AND master_created_at IS NOT NULL"
      )
    );
  });

  it("requires an exact critic approval before reservation", () => {
    assert.ok(reserveMaster.inputSchema instanceof z.ZodType);
    const payload = {
      sourceIssueId: "ENG-123",
    };
    assert.equal(reserveMaster.inputSchema.safeParse(payload).success, false);
    assert.equal(
      reserveMaster.inputSchema.safeParse({
        ...payload,
        criticApprovalId: reservationInput.approvalId,
      }).success,
      true
    );
  });

  it("accepts only bounded Linear and reservation identifiers on completion", () => {
    assert.ok(completeReservation.inputSchema instanceof z.ZodType);
    assert.equal(
      completeReservation.inputSchema.safeParse({
        masterIssueId: "ENG-123",
        reservationId: "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
        sourceIssueId: "ENG-124",
      }).success,
      true
    );
    assert.equal(
      completeReservation.inputSchema.safeParse({
        masterIssueId: "not-linear",
        reservationId: "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
        sourceIssueId: "ENG-124",
      }).success,
      false
    );
  });

  it("reads the master creation time from the exact Linear issue", async () => {
    let authorization = "";
    const createdAt = await readLinearMasterCreatedAt(
      "linear-token",
      "ENG-123",
      "ENG-124",
      {
        fetcher: (_input, init) => {
          authorization = String(
            (init?.headers as Record<string, string> | undefined)?.Authorization
          );
          assert.ok(init?.signal);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  master: {
                    createdAt: "2026-08-24T12:00:00.000Z",
                    identifier: "ENG-123",
                  },
                  source: {
                    identifier: "ENG-124",
                    parent: { identifier: "ENG-123" },
                  },
                },
              }),
              { status: 200 }
            )
          );
        },
      }
    );
    assert.equal(createdAt, "2026-08-24T12:00:00.000Z");
    assert.equal(authorization, "Bearer linear-token");
  });

  it("fails closed when Linear returns a different issue or an error", async () => {
    const response = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200 });
    assert.equal(
      await readLinearMasterCreatedAt("token", "ENG-123", "ENG-124", {
        fetcher: () =>
          Promise.resolve(
            response({
              data: {
                master: {
                  createdAt: "2026-08-24T12:00:00.000Z",
                  identifier: "ENG-999",
                },
                source: {
                  identifier: "ENG-124",
                  parent: { identifier: "ENG-123" },
                },
              },
            })
          ),
      }),
      null
    );
    assert.equal(
      await readLinearMasterCreatedAt("token", "ENG-123", "ENG-124", {
        fetcher: () =>
          Promise.resolve(
            response({
              data: { master: null, source: null },
              errors: [{ message: "private" }],
            })
          ),
      }),
      null
    );
    assert.equal(
      await readLinearMasterCreatedAt("token", "ENG-123", "ENG-124", {
        fetcher: () =>
          Promise.resolve(
            response({
              data: {
                master: {
                  createdAt: "2026-08-24T12:00:00.000Z",
                  identifier: "ENG-123",
                },
                source: { identifier: "ENG-124", parent: null },
              },
            })
          ),
      }),
      null
    );
    assert.equal(
      await readLinearMasterCreatedAt("token", "ENG-123", "ENG-124", {
        fetcher: () =>
          Promise.reject(new DOMException("Timed out", "AbortError")),
      }),
      null
    );
  });

  it("anchors completion time to the active reservation generation", async () => {
    let statement = "";
    const database: ReservationDatabase = {
      query(sql) {
        statement = sql;
        return Promise.resolve([]);
      },
    };
    await completeMasterReservation(
      "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
      "ENG-124",
      "ENG-123",
      "2026-08-24T12:00:00.000Z",
      database
    );
    assert.ok(statement.includes("updated_at - interval '5 minutes'"));
    assert.ok(statement.includes("now() + interval '1 minute'"));
    assert.ok(statement.includes("source_issue_id = $5"));
  });
});
