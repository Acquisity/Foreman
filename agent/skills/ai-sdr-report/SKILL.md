---
description: "Weekly AI SDR performance report: call the fixed report tool once and render its deterministic metrics as Slack-native tables plus a short summary. Load for every ai-sdr-report schedule dispatch."
---

# AI SDR weekly report

Produce the weekly AI SDR performance report for the channel the schedule dispatched to.

## Get the report

Call `read_ai_sdr_weekly_report` exactly once with no input. It owns the report windows, fixed production queries, AI SDR booking boundary, arithmetic, and deltas. Do not call another data tool and do not recalculate the returned values.

If it returns `success: false`, post one short line saying the weekly report could not be generated and include the safe error. Do not invent a partial report.

## Render the report

Post exactly one message. Start with the report window from `windows.report`. Use unfenced Markdown tables so Slack converts them to native table blocks. Do not use code fences or manually aligned plain text.

Every table uses these columns in this order:

`Metric | This wk | Last wk | Δ WoW | Same wk last month | Δ MoM`

Render count deltas from `wowPercent` and `momPercent` with a `%` suffix. Render `null` count deltas as `n/a` because a zero baseline has no meaningful percentage change. Render rate deltas from `wowPercentagePoints` and `momPercentagePoints` with a `pp` suffix. Rates and deltas use one decimal place, except reply rate and its deltas use two decimal places. Counts can use compact `k` or `M` notation when helpful.

Use these five sections in order:

1. `Volume and booked meetings`: Emails sent, Replies, Positive replies (Instantly), Booked meetings.
2. `Conversion rates`: Reply rate, Positive reply rate, Booked meeting rate. Add one plain line that booked meeting rate uses AI SDR booked meetings divided by Instantly positive replies.
3. `Booked meeting rate by campaign type`: podcast, direct, interview, lead-magnet. The primary value is each method's `bookedMeetingRate`; do not combine methods. Add one plain line that remaining types are too small to read a trend from.
4. `AI SDR lifecycle, every stage`: Replied, Slots sent, Booked, Completed, Declined, No response.
5. `Lifecycle step conversion`: Slots sent / replied, Booked / slots sent, Completed / booked.

After the lifecycle tables, add this exact meaning in one plain line: Completed lags because a meeting only completes after its date, so recent weeks fill in late.

End with `Summary` and exactly three short, plain-language lines labeled `Trend:`, `Improvement:`, and `Watch:`. Base them only on the returned values. No em dashes and no bold for emphasis.
