---
description: "Weekly AI SDR performance report: run the PlanetScale queries for the three windows the dispatch provides, compute conversion and lifecycle rates with week-over-week and month-over-month deltas, and post one Markdown-table report plus a short summary to the channel. Load for every ai-sdr-report schedule dispatch."
---

# AI SDR weekly report

Produce the weekly AI SDR performance report for the channel the schedule dispatched to. The dispatch names three windows: this report week (the previous Monday through Friday), the week before, and the same week last month. Every number gets a delta against the week before (WoW) and against the same week last month (MoM). The report always posts; there is no empty state.

## Definitions that matter

- **Booked calls** come from `scheduling_external_booking` (a real booked meeting), filtered to `deleted_at IS NULL`.
- **Positive replies** for the booked meeting rate come from Instantly's count, which is `outreach_campaign_metrics.positive_replies`. Never use the AI SDR's own positive classification for this rate.
- **Campaign type** is `outreach_campaign.email_scripts_method` (podcast, direct, interview, lead-magnet, and so on).
- **Lifecycle stage** is the first time a thread reaches a stage, read from `crm_message_thread.lifecycle_history`.

## Tools

`planetscale_execute_read_query` (bare name) is the only data tool. Run read-only SQL; postgres database name is `postgres`. Table and column shapes come from `information_schema.columns` when a name is unclear. Results are capped at 256 KB; when `truncated` is true, narrow the query rather than concluding from a partial result.

## Queries

The dispatch provides six strings per window: `start`, `end`, and `endExclusive`, all `YYYY-MM-DD`. Text `date` columns take `date >= '<start>' AND date <= '<end>'`; timestamps take `>= '<start>' AND < '<endExclusive>'`. Run each query for the report window, the previous window, and the same-week-last-month window.

### Volume and replies

```sql
SELECT
  sum(emails_sent) AS sent,
  sum(replies_received) AS replies,
  sum(positive_replies) AS positive
FROM outreach_campaign_metrics
WHERE date >= '<start>' AND date <= '<end>';
```

### Booked calls

```sql
SELECT
  count(*) AS booked,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM scheduling_external_booking
WHERE deleted_at IS NULL
  AND created_at >= '<start>' AND created_at < '<endExclusive>';
```

### Campaign type (positive replies and booked per method)

```sql
SELECT c.email_scripts_method AS method, sum(m.positive_replies) AS positive
FROM outreach_campaign_metrics m
JOIN outreach_campaign c ON c.id = m.campaign_id
WHERE m.date >= '<start>' AND m.date <= '<end>'
GROUP BY 1;
```

```sql
SELECT c.email_scripts_method AS method, count(*) AS booked
FROM scheduling_external_booking b
JOIN outreach_campaign c ON c.id = b.campaign_id
WHERE b.deleted_at IS NULL
  AND b.created_at >= '<start>' AND b.created_at < '<endExclusive>'
GROUP BY 1;
```

### Lifecycle stage counts

First time each thread reaches each stage, bucketed by window:

```sql
WITH transitions AS (
  SELECT t.id AS thread_id, e->>'to' AS stage, (e->>'timestamp')::timestamptz AS ts
  FROM crm_message_thread t, jsonb_array_elements(t.lifecycle_history) e
  WHERE t.lifecycle_history IS NOT NULL
),
first_arrival AS (
  SELECT DISTINCT ON (thread_id, stage) thread_id, stage, ts
  FROM transitions ORDER BY thread_id, stage, ts
)
SELECT stage,
  count(*) FILTER (WHERE ts >= '<reportStart>' AND ts < '<reportEndExclusive>') AS report,
  count(*) FILTER (WHERE ts >= '<prevStart>' AND ts < '<prevEndExclusive>') AS previous,
  count(*) FILTER (WHERE ts >= '<monthStart>' AND ts < '<monthEndExclusive>') AS month
FROM first_arrival
GROUP BY 1;
```

This one fills all three windows in a single pass, so run it once.

## Compute the rates

- **Reply rate** = replies / sent.
- **Positive reply rate** = positive / replies.
- **Booked meeting rate** = booked / positive (Instantly positives, as above).
- **By campaign type**, booked meeting rate = method's booked / method's positive.
- **Lifecycle step rates**: slots_sent / replied, booked / slots_sent, completed / booked.

Deltas for rates are percentage points (pp). Deltas for counts are percent change. Round counts to integer or one decimal with k/M, percentages to one decimal.

## Report format

Post exactly one message. Use Markdown tables (not code fences), each with columns `This wk | Last wk | Δ WoW | Same wk last month | Δ MoM`. Order:

1. **Volume and booked calls** table: Emails sent, Replies, Positive replies (Instantly), Booked calls.
2. **Conversion rates** table: Reply rate, Positive reply rate, Booked meeting rate. Note under it that the booked meeting rate uses Instantly positive replies, not the AI SDR positive count.
3. **Booked meeting rate by campaign type** table, listing podcast, direct, interview, lead-magnet, and noting that the remaining types are too small to read a trend from.
4. **AI SDR lifecycle, every stage** table: Replied, Slots sent, Booked, Completed, Declined, No response, each with count and deltas.
5. **Lifecycle step conversion** table: Slots sent / replied, Booked / slots sent, Completed / booked.

End with a **Summary** of three short plain-language lines: trends, improvements, and things to watch. No em dashes, no bold for emphasis.

Always note in one line that "Completed" lags behind because a meeting only completes after its date, so recent weeks fill in late.
