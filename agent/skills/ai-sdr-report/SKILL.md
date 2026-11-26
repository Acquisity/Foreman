---
description: "Weekly AI SDR performance report: write the three-line summary in the thread under the charts and tables the schedule already posted. Load for every ai-sdr-report schedule dispatch."
---

# AI SDR weekly report

The schedule has already read the report and posted it as charts and tables in the AI SDR channel. You're in that post's thread. Write the summary readers look for under it.

## Read the report

The report is the JSON at the end of the dispatch message. It owns the windows, figures and deltas, so use its values as given. Do not call any tool. A failed read never reaches this skill, because the schedule posts the failure line itself.

## Write the summary

Post exactly one message: three short, plain-language lines labelled `Trend:`, `Improvement:` and `Watch:`, and nothing else. Each line names the figures it rests on, with the report's own deltas: count changes as `%`, rate changes as `pp`, one decimal place, except reply rate at two.

- `Trend:` the week's overall direction, led by booked meetings and booked meeting rate.
- `Improvement:` the clearest gain on last week or the same week last month.
- `Watch:` the clearest drop or risk, such as a falling lifecycle step or campaign type.

Completed meetings lag because a meeting only completes after its date, so a low completed count is not a Watch item on its own.

Example (the 16 to 20 Nov 2026 report):

Trend: Booked meetings rose 7.4% on last week and 69.1% on the same week last month, and the booked meeting rate held near 18%, down 1.0pp on the week.
Improvement: Podcast's booked meeting rate is up 5.3pp and direct's 2.1pp on the same week last month, and replies grew 10.0% on the week.
Watch: Booked per slots sent fell 5.8pp, no response grew 40.4% on the week, and interview's booked meeting rate is down 5.7pp on last month.

No headings, tables, code fences, bold or em dashes.
