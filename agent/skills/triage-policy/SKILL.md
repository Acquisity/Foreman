---
description: "Fleet-wide triage policy for every investigation agent — the investigation stance and its rule-out ladder, severity weighting and priority bands, and the Engineering area-routing roster. Load before classifying, prioritising, or routing anything. Agent-specific procedure lives in that agent's own skill and references this one."
---

# Triage policy

The parts of triage that are the same in every investigation agent: the stance, the classifications, severity weighting, and the routing roster. Per-agent skills describe *their* procedure — which source to read first, what the output looks like, who the audience is — and rely on this for stance, severity, and routing.

## Investigation stance

Start skeptical that the report is a product bug. Before calling anything a bug, rule out:

- user/account setup
- workspace, campaign, domain, inbox, CRM, or provider configuration
- permissions, billing, entitlements, limits, credits, expected product behavior
- provider/platform limitations
- duplicate reports or already-known issues

`Bug` is the last classification, only with direct evidence of an internal failure: logs, failed jobs, schema mismatch, provider/API error, repeatable incorrect behavior, or data/state the user could not have caused. Bug is the verdict of last resort, and every finding carries proof of work and a quantified blast radius, not adjectives.

Exactly one classification per finding:

- `User Error`: settings/configuration/operator-solvable/needs-human-review cases support can explain or follow up on without a platform limitation or bug.
- `Platform Limitation`: expected limitation, provider limitation, billing/entitlement/plan limit, or known unsupported behavior.
- `Bug`: direct evidence of internal failure that settings, configuration, and platform limits do not explain.

A suspicion is never a confirmed `Bug`. When the cause needs a confirmation only a person can supply and it has not landed, do not force one of the three: hand back what is known with the missing confirmation named — no ticket, and nothing that reads as settled.

## Severity weighting

Priority comes from impact, never from the reporter's requested priority or how loudly the complaint was phrased. Weigh these in order:

1. **Data loss / security** — any data corruption, loss, or security exposure is automatic `Urgent`, no matter how few accounts are affected.
2. **Blast radius** — quantified from primary data ("N orgs", "N users"), not estimated. A core workflow broken for many orgs outweighs one broken for a single org.
3. **Workaround** — no viable workaround raises the call one band; an acceptable workaround lowers it one.
4. **Frequency** — a small failure that hits every send/sync outweighs a severe one that fires rarely.
5. **Customer tier** — enterprise/partner exposure breaks ties only. Never a reason to inflate a band.
6. **Money** — an active billing/refund blocker is at least `High`.

Bands:

- `Urgent`: production outage, security/data-loss risk, major revenue or customer-trust incident, or a core workflow blocked for many orgs with no workaround.
- `High`: multiple orgs blocked on a core workflow, money issue requiring action, repeat production failure, or an enterprise customer blocked with no workaround.
- `Medium`: a real defect with a workaround, single-org impact, or non-blocking money follow-up.
- `Low`: cosmetic, edge case, platform limitation, resolved-by-triage, or backlog/low-impact.

Between two bands take the higher one and write the rationale where the verdict lives — overestimate, then calibrate down with a domain expert. Duplicates inherit the parent's priority.

## Engineering area-routing roster

Assign by the product area the issue is in. Use the emails verbatim: the routing map only accepts assignees on its allowlist, and an unlisted area owner falls back to Aaron Fraga.

- AI SDR → Koppany Kondricz (`koppany.kondricz@acquisity.ai`)
- Cold Email → Anthony Adewale (`anthony.adewale@acquisity.ai`)
- Website Builder → James Keeble (`james.keeble@aiacquisition.com`)
- Core Platform → Anuj Bhatt (`anuj.bhatt@acquisity.ai`), fallback James Keeble
- CRM → Ebubeker Rexha (`ebubeker.rexha@acquisity.ai`)
- Acquisity Agent (AI Consultant) → Jil Patel (`jil.patel@acquisity.ai`)
- Anything else → Aaron Fraga (`aaron.fraga@acquisity.ai`)

Scope rules that come with the roster:

- The roster exists on the production **ENG** team only. Tickets on the SAN (sandbox) team always route to Aaron Fraga, whatever the area.
- If you cannot tell which area an issue belongs to, assign Aaron Fraga and say why the area was ambiguous. Never guess an owner.
- If a project has no lead set, or the roster is unavailable on a run, assign Aaron Fraga and say in the report that routing needs a human. A guessed owner is worse than an explicit hand-off.
- Never route to retired or legacy projects.
