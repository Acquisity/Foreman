import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type executorConnection,
  sessionExecutorConnection,
} from "./executor/connection.js";
import { invokeProvider } from "./executor/dispatch.js";
import { FIN_PREVIEW_TOOLKIT, toolkitUrl } from "./executor/endpoint.js";
import { executorTransport } from "./executor/transport.js";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import { finInvestigationAuth } from "./fin-investigation-auth.js";
import { sessionLane } from "./session-lane.js";

test("Fin uses the Preview toolkit without removing ordinary investigation capabilities", async (t) => {
  const auth = finInvestigationAuth(verifiedFinContext);
  const session = { auth: { current: auth, initiator: auth } };
  const resolve = sessionExecutorConnection().events["session.started"];
  assert.ok(resolve);
  const connection = (await Reflect.apply(resolve, undefined, [
    {},
    { session },
  ])) as ReturnType<typeof executorConnection>;
  assert.equal(connection.url, toolkitUrl(FIN_PREVIEW_TOOLKIT));
  assert.ok(typeof connection.approval === "function");
  assert.equal(
    Reflect.apply(connection.approval, undefined, [
      { session, toolName: "executor__execute" },
    ]),
    "not-applicable"
  );
  const lane = sessionLane(auth);
  assert.equal(lane.broadExecutor, true);
  assert.equal(lane.repository, true);
  assert.ok(lane.instructions.includes(verifiedFinContext.organizationId));
  t.mock.method(
    executorTransport,
    "call",
    (wire: Parameters<typeof executorTransport.call>[0]) => {
      assert.equal(wire.toolkit, FIN_PREVIEW_TOOLKIT);
      return Promise.resolve({ data: { count: 217 }, ok: true });
    }
  );
  const result = await invokeProvider(
    {
      abortSignal: new AbortController().signal,
      getToken: async () => ({ token: "test" }),
      session,
    } as unknown as Parameters<typeof invokeProvider>[0],
    "planetscale.org.foremanPlanetscale.execute_read_query",
    { query: "SELECT 1" }
  );
  assert.deepEqual(result, { data: { count: 217 }, ok: true });
});

test("ordinary sessions still resolve the existing shared toolkit", async () => {
  const resolve = sessionExecutorConnection().events["session.started"];
  assert.ok(resolve);
  const connection = (await Reflect.apply(resolve, undefined, [
    {},
    { session: { auth: {} } },
  ])) as ReturnType<typeof executorConnection>;
  assert.equal(connection.url, toolkitUrl());
});
