---
description: "Weekly AI SDR performance report: write the three-line summary in the thread under the charts and tables the schedule already posted. Load for every ai-sdr-report schedule dispatch."
---

# AI SDR weekly report

The schedule has already read the report and posted it as charts and tables in the AI SDR channel. You're in that post's thread. Write the summary readers look for under it.

## Read the report

The report is the JSON at the end of the dispatch message. It owns the windows, figures and deltas, so use its values as given. Do not call any tool. A failed read never reaches this skill, because the schedule posts the failure line itself.

## Write the summary

Post exactly one message: three short, plain-language lines labelled `Trend:`, `Improvement:` and `Watch:`, and nothing else. Each line names the figures it rests on, with the report's own deltas: count changes as `%`, rate changes as `pp`, one decimal place, except reply rate at two. A `null` count change is `n/a`, because a zero baseline has no percentage change.

- `Trend:` the week's overall direction, led by booked meetings and booked meeting rate.
- `Improvement:` the clearest gain on last week or the same week last month.
- `Watch:` the clearest drop or risk, such as a falling lifecycle step or campaign type.

Completed meetings lag because a meeting only completes after its date, so a low completed count is not a Watch item on its own.

Booked meetings count every AI SDR booking made in the week, once per guest, including ones cancelled or declined since, so a week's count doesn't change later. Cancelled or declined since keeps growing for recent weeks, so a lower figure this week than last is not an Improvement on its own.

Example (the 16 to 20 Nov 2026 report):

Trend: Booked meetings rose 2.8% on last week and 58.1% on the same week last month, but the booked meeting rate fell 2.1pp on the week to 21.4%.
Improvement: Podcast's booked meeting rate is up 5.2pp and direct's 1.8pp on the same week last month, and replies grew 9.9% on the week.
Watch: Interview's booked meeting rate is down 8.7pp on last month, and no response grew 40.4% on the week.

No headings, tables, code fences, bold or em dashes.
