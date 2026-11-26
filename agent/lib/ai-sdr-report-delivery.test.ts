import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { deliverAiSdrReport } from "./ai-sdr-report-delivery.js";
import type { AiSdrWeeklyReportResult } from "./ai-sdr-weekly-report.js";
import type { SlackChannelMessage } from "./slack-channel-post.js";

const report = JSON.parse(
  readFileSync(
    new URL("./fixtures/ai-sdr-weekly-report.json", import.meta.url),
    "utf8"
  )
) as AiSdrWeeklyReportResult;

const recorder = () => {
  const posts: SlackChannelMessage[] = [];
  const dispatches: { prompt: string; threadTs: string }[] = [];
  return {
    dispatch: (prompt: string, threadTs: string) => {
      dispatches.push({ prompt, threadTs });
      return Promise.resolve();
    },
    dispatches,
    post: (message: SlackChannelMessage) => {
      posts.push(message);
      return Promise.resolve("1795438861.817009");
    },
    posts,
  };
};

describe("deliverAiSdrReport", () => {
  test("posts only the fixed line from code on a failed read and never starts a model turn", async () => {
    const { dispatch, dispatches, post, posts } = recorder();
    await deliverAiSdrReport({
      dispatch,
      post,
      read: () =>
        Promise.resolve({ error: "a production read failed", success: false }),
    });
    assert.deepEqual(posts, [
      {
        text: "The weekly AI SDR report could not be generated: a production read failed",
      },
    ]);
    assert.deepEqual(dispatches, []);
  });

  test("posts the charts and tables from code, then has the model summarise in that post's thread", async () => {
    const { dispatch, dispatches, post, posts } = recorder();
    await deliverAiSdrReport({
      dispatch,
      post,
      read: () => Promise.resolve(report),
    });
    assert.equal(posts.length, 1);
    const types = (posts[0]?.blocks ?? []).map(
      (block) => (block as { type: string }).type
    );
    assert.equal(
      types.filter((type) => type === "data_visualization").length,
      2
    );
    assert.equal(types.filter((type) => type === "table").length, 3);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]?.threadTs, "1795438861.817009");
    assert.ok(dispatches[0]?.prompt.includes("Do not call any tool."));
    assert.ok(dispatches[0]?.prompt.endsWith(JSON.stringify(report)));
  });
});
