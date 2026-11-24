import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { verifiedWidgetContext } from "../../agent/lib/widget.fixture.js";
import { askedAtLine } from "../../agent/lib/widget-asked-at.js";
import { defaultGateDeps } from "../../agent/lib/widget-egress.js";

const RUNS = 10;
const TODAY = /\btoday\b/iu;
const TOMORROW = /\btomorrow\b/iu;

export default defineEval({
  description:
    "ENG-20503: asked on Tuesday 24 Nov at 10:45 AM Pacific, the composed reply calls the AI SDR's offered Wednesday 25 Nov 11:00 AM PST meeting tomorrow, never today, in 10 of 10 runs.",
  tags: ["widget"],
  async test(t) {
    const missing = ["CLIPROXY_BASE_URL", "CLIPROXY_API_KEY"].filter(
      (name) => !process.env[name]?.trim()
    );
    if (missing.length) {
      t.skip(`missing ${missing.join(", ")}`);
    }
    const scope = {
      ...verifiedWidgetContext,
      officeHours: {
        customerTimeZone: "America/Los_Angeles",
        enabled: false,
        nextOpenAt: null,
        nextOpenText: null,
        open: true,
        replyTimeMinutes: 20,
        replyTimeText: "20 minutes",
        showReplyTime: true,
        timeZone: "America/New_York",
      },
    };
    const input = {
      askedAt: askedAtLine(scope, new Date("2026-11-24T18:45:00.000Z")),
      findings: {
        confidence: "high" as const,
        facts: [
          {
            claim:
              "The conversation with Thomas was escalated to you on 20 November because the AI SDR's reply could not be safely corrected.",
          },
          {
            claim:
              "The AI SDR offered Thomas a meeting on Wednesday, 25 November 2026 at 11:00 AM PST.",
          },
        ],
        needsHuman: false,
        recommendation:
          "Check your calendar for the meeting with Thomas on Wednesday, 25 November at 11:00 AM PST, and resume the AI SDR from the thread once you have replied.",
      },
      organizationName: scope.organizationName,
      question:
        "Why was my conversation with Thomas escalated to me, and can the AI SDR take it back over now?",
      recordingOffered: false,
    };
    const replies: string[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is a separate real reply, counted one by one.
      replies.push(await defaultGateDeps.compose(input));
    }
    const wrong = replies.filter(
      (reply) => TODAY.test(reply) || !TOMORROW.test(reply)
    );
    t.log(
      `${RUNS - wrong.length} of ${RUNS} replies call the meeting tomorrow`
    );
    await t.require(
      wrong.length === 0,
      satisfies(Boolean, "every reply calls the 25 Nov meeting tomorrow")
    );
  },
  timeoutMs: 600_000,
});
