import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WIDGET_TICKET_OWNER } from "./executor/dispatch.js";
import type { JevAnswer } from "./jev.js";
import {
  billingQuestions,
  resolveBilling,
  resolveTriage,
  type TriageInput,
  triageQuestions,
} from "./jev-decisions.js";
import {
  AREA_KEYS,
  AREAS,
  type AreaKey,
  areaForPath,
  areaForProject,
  areaLabels,
  developerLabelsAllowed,
  FALLBACK_OWNER,
  isDeveloperOwner,
  mappedOwner,
  ownerNames,
  SUPPORT_OWNER,
} from "./owner-map.js";
import { renderRoster } from "./owner-roster.js";

const yes = (): JevAnswer => ({ probability: 0.9, type: "boolean" });
const no = (): JevAnswer => ({ probability: 0.1, type: "boolean" });
const pick = (choice: string, confidence = 0.9): JevAnswer => ({
  choice,
  probabilities: { [choice]: confidence },
  type: "choice",
});

const input = (over: Partial<TriageInput> = {}): TriageInput => ({
  blastRadius: {
    countedAt: "2026-10-23",
    orgs: 2,
    query: "select 1",
    users: 3,
  },
  claim: "A claim.",
  codePath: { commit: "a".repeat(40), file: "lib/thing.ts", function: "run" },
  duplicateCandidates: [],
  evidence: "Evidence.",
  identifier: "ENG-1",
  projects: [{ name: "CRM" }],
  rootCauseLabels: [],
  sourceLabels: ["Customer reported"],
  ...over,
});

const answers = (over: Record<string, JevAnswer> = {}) => ({
  area: pick("undetermined"),
  classification: pick("bug"),
  data_loss_or_security: no(),
  direct_evidence: yes(),
  impact: { probabilities: { "1": 0.9 }, score: 1, type: "score" } as JevAnswer,
  incident: pick("standard"),
  incident_impact: pick("MATERIALLY_IMPAIRED"),
  money_blocker: no(),
  path: pick("Engineering Todo"),
  project: pick("undetermined"),
  verdict: pick("supported"),
  wants_limit_lifted: no(),
  ...over,
});

const route = (decision: ReturnType<typeof resolveTriage>) => {
  assert.ok(decision.outcome === "route");
  return decision;
};

describe("the owner map", () => {
  it("names each owner James set on 22 and 23 Oct 2026", () => {
    const expected: Record<AreaKey, string> = {
      acquisity_agent: "James Keeble",
      ai_sdr: "Koppany Kondricz",
      billing: "Anthony Adewale",
      cold_email: "Anthony Adewale",
      core_platform: "Anuj Bhatt",
      crm_conversations: "Elis Bushaj",
      crm_phone: "Ebubeker Rexha",
      crm_records: "Ebubeker Rexha",
      crm_work: "Ebubeker Rexha",
      devops: "James Keeble",
      inboxes_domains: "Anthony Adewale",
      other: "James Keeble",
      refunds: "Aaron Fraga",
      widget: "Aaron Fraga",
      workflows: "James Keeble",
    };
    for (const key of AREA_KEYS) {
      assert.equal(AREAS[key].owner, expected[key], key);
    }
    assert.deepEqual(ownerNames(), [
      "Aaron Fraga",
      "Anthony Adewale",
      "Anuj Bhatt",
      "Ebubeker Rexha",
      "Elis Bushaj",
      "James Keeble",
      "Koppany Kondricz",
    ]);
  });

  it("has one distinct Area label per row and no leaver", () => {
    assert.equal(new Set(areaLabels()).size, AREA_KEYS.length);
    for (const name of ["Pieter Venter", "Jil Patel", "Mahmut Jomaa"]) {
      assert.equal(mappedOwner(name), null, name);
    }
  });

  it("keeps support owners out of the developer lane", () => {
    assert.equal(isDeveloperOwner(SUPPORT_OWNER), false);
    assert.equal(isDeveloperOwner(FALLBACK_OWNER), true);
    assert.equal(AREAS.widget.owner, WIDGET_TICKET_OWNER.assignee);
    assert.equal(AREAS.refunds.lane, "support");
  });

  it("renders the roster the agent reads from the map, byte for byte", () => {
    const roster = readFileSync(
      new URL(
        "../skills/triage-handling/references/roster.md",
        import.meta.url
      ),
      "utf8"
    );
    assert.equal(roster, renderRoster());
    for (const key of AREA_KEYS) {
      assert.ok(roster.includes(`\`${key}\``), key);
      assert.ok(roster.includes(AREAS[key].label), key);
      assert.ok(roster.includes(AREAS[key].owner), key);
    }
  });

  it("passes the roster check script that guards drift", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const run = () =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/render-roster.ts", "--check"],
        { cwd: root, stdio: "pipe" }
      );
    assert.doesNotThrow(run);
  });

  it("maps each known Linear project to one area", () => {
    const projects: [string, AreaKey][] = [
      ["AI SDR Core", "ai_sdr"],
      ["AI SDR Inbox & UI", "ai_sdr"],
      ["Cold Email Core", "cold_email"],
      ["Cold Email Leads", "cold_email"],
      ["Cold Email Agent", "cold_email"],
      ["Billing", "billing"],
      ["Domains & Inboxes", "inboxes_domains"],
      ["CRM", "crm_records"],
      ["CRM Phone Calling & Texting", "crm_phone"],
      ["CRM Calendar Scheduling", "crm_work"],
      ["Core Platform", "core_platform"],
      ["Dev Ops", "devops"],
      ["Acquisity Agent", "acquisity_agent"],
      ["Workflows", "workflows"],
      ["Acquisity Chat Widget", "widget"],
      ["Support", "refunds"],
    ];
    for (const [project, key] of projects) {
      assert.equal(areaForProject(project), key, project);
    }
    assert.equal(areaForProject("AI Website Builder"), null);
  });

  it("splits CRM by code path, with conversations and notifications going to Elis", () => {
    const paths: [string, AreaKey][] = [
      ["apps/web/components/notifications/drawer.tsx", "crm_conversations"],
      [
        "apps/web/components/crm-v2/conversations/thread.tsx",
        "crm_conversations",
      ],
      ["apps/web/trpc/routers/conversations.ts", "crm_conversations"],
      ["apps/web/components/crm/power-dialer/queue.tsx", "crm_phone"],
      ["apps/web/trpc/routers/sms.ts", "crm_phone"],
      ["apps/web/lib/dialer/session.ts", "crm_phone"],
      ["apps/web/components/crm-v2/sequences/list.tsx", "crm_work"],
      ["apps/web/components/calendar/grid.tsx", "crm_work"],
      ["apps/web/components/crm/crm-data-table/table.tsx", "crm_records"],
      ["apps/web/lib/crm/schema.ts", "crm_records"],
    ];
    for (const [file, key] of paths) {
      assert.equal(areaForPath(file), key, file);
    }
    assert.equal(areaForPath("apps/web/lib/billing/plan.ts"), null);
  });
});

describe("routing a sample of each area", () => {
  const samples: [string, AreaKey, string][] = [
    ["AI SDR Core", "ai_sdr", "Koppany Kondricz"],
    ["Cold Email Leads", "cold_email", "Anthony Adewale"],
    ["Billing", "billing", "Anthony Adewale"],
    ["Domains & Inboxes", "inboxes_domains", "Anthony Adewale"],
    ["CRM", "crm_records", "Ebubeker Rexha"],
    ["CRM Phone Calling & Texting", "crm_phone", "Ebubeker Rexha"],
    ["Core Platform", "core_platform", "Anuj Bhatt"],
    ["Dev Ops", "devops", "James Keeble"],
    ["Acquisity Agent", "acquisity_agent", "James Keeble"],
    ["Workflows", "workflows", "James Keeble"],
    ["AI Website Builder", "other", "James Keeble"],
  ];

  for (const [project, key, owner] of samples) {
    it(`sends a Bug in ${project} to ${owner}`, () => {
      const decision = route(
        resolveTriage(
          input({ projects: [{ name: project }] }),
          answers({ project: pick(project) })
        )
      );
      assert.equal(decision.assignee, owner);
      assert.equal(decision.route.assignee, owner);
      assert.equal(decision.area?.key, key);
      assert.ok(decision.route.addLabels.includes(AREAS[key].label));
    });
  }

  it("lets the model's area answer place a Bug that has no project", () => {
    const decision = route(
      resolveTriage(input(), answers({ area: pick("core_platform") }))
    );
    assert.equal(decision.assignee, "Anuj Bhatt");
    assert.equal(decision.route.project, undefined);
  });

  it("splits a CRM Bug by the file it runs through", () => {
    const conversations = route(
      resolveTriage(
        input({
          codePath: {
            commit: "a".repeat(40),
            file: "apps/web/components/notifications/card.tsx",
            function: "Card",
          },
        }),
        answers({ project: pick("CRM") })
      )
    );
    assert.equal(conversations.assignee, "Elis Bushaj");
    assert.equal(conversations.area?.key, "crm_conversations");
    const phone = route(
      resolveTriage(
        input({
          codePath: {
            commit: "a".repeat(40),
            file: "apps/web/lib/dialer/session.ts",
            function: "start",
          },
        }),
        answers({ project: pick("CRM") })
      )
    );
    assert.equal(phone.assignee, "Ebubeker Rexha");
  });

  it("routes a Bug that matches no area to James", () => {
    const decision = route(resolveTriage(input(), answers()));
    assert.equal(decision.assignee, "James Keeble");
    assert.equal(decision.area?.matched, false);
  });
});

describe("who may be assigned to a developer", () => {
  const platformLimit = (over: Record<string, JevAnswer> = {}) =>
    answers({
      classification: pick("platform_limitation"),
      path: pick("Platform Limitation"),
      wants_limit_lifted: yes(),
      ...over,
    });

  it("gives a confirmed Bug an owner", () => {
    const decision = route(
      resolveTriage(input(), answers({ project: pick("CRM") }))
    );
    assert.equal(decision.assignee, "Ebubeker Rexha");
    assert.equal(decision.approval, "not-applicable");
  });

  it("gives an approved feature request an owner and a place on the board", () => {
    const decision = route(
      resolveTriage(
        input({ ticketLabels: ["Approved", "Feature Request"] }),
        platformLimit({ area: pick("ai_sdr") })
      )
    );
    assert.equal(decision.approval, "approved");
    assert.equal(decision.assignee, "Koppany Kondricz");
    assert.equal(decision.route.state, "Todo");
    assert.ok(decision.route.addLabels.includes("Feature Request"));
    assert.equal(decision.route.addLabels.includes("Needs approval"), false);
  });

  it("holds an unapproved feature request for James and gives it no developer", () => {
    const decision = route(
      resolveTriage(input(), platformLimit({ area: pick("ai_sdr") }))
    );
    assert.equal(decision.approval, "needed");
    assert.equal(decision.assignee, null);
    assert.equal(decision.area, null);
    assert.equal(decision.route.assignee, undefined);
    assert.ok(decision.route.addLabels.includes("Needs approval"));
    assert.equal(
      decision.route.addLabels.some((label) => label.startsWith("Area:")),
      false
    );
    assert.ok(decision.notes.some((note) => note.includes("James")));
  });

  it("gives a user error no developer", () => {
    const decision = route(
      resolveTriage(
        input(),
        answers({
          area: pick("ai_sdr"),
          classification: pick("user_error"),
          path: pick("User Error"),
        })
      )
    );
    assert.equal(decision.assignee, null);
    assert.equal(decision.route.assignee, undefined);
    assert.equal(decision.approval, "not-applicable");
  });

  it("gives a platform limitation nobody wants lifted no developer", () => {
    const decision = route(
      resolveTriage(
        input(),
        platformLimit({ area: pick("ai_sdr"), wants_limit_lifted: no() })
      )
    );
    assert.equal(decision.assignee, null);
    assert.equal(decision.approval, "not-applicable");
  });

  it("gives a low-impact backlog Bug no developer", () => {
    const decision = route(
      resolveTriage(
        input(),
        answers({ area: pick("ai_sdr"), path: pick("Backlog/low-impact") })
      )
    );
    assert.equal(decision.assignee, null);
  });

  it("gives a Support follow-up no developer", () => {
    const decision = route(
      resolveTriage(
        input(),
        answers({
          area: pick("ai_sdr"),
          classification: pick("user_error"),
          path: pick("Support/Product follow-up"),
        })
      )
    );
    assert.equal(decision.assignee, null);
  });

  it("sends billing and refund items to the support owner, never a developer", () => {
    const decision = resolveBilling(
      {
        approvalQuote: "quote",
        bucket: "refund",
        evidence: "e",
        sourceLabels: [],
      },
      Object.fromEntries(
        Object.entries(billingQuestions()).map(([key, question]) => [
          key,
          question.type === "boolean" ? yes() : pick("justified"),
        ])
      )
    );
    assert.equal(decision.route.assignee, SUPPORT_OWNER);
    assert.equal(isDeveloperOwner(decision.route.assignee), false);
  });

  it("gives a duplicate of a Bug the area owner as its fallback", () => {
    const decision = route(
      resolveTriage(
        input({
          duplicateCandidates: [
            { identifier: "ENG-9", priority: 2, summary: "s", title: "t" },
          ],
        }),
        answers({
          area: pick("billing"),
          duplicate_0: pick("same_outcome", 0.9),
        })
      )
    );
    assert.equal(decision.path, "Duplicate");
    assert.equal(decision.route.assignee, "Anthony Adewale");
    assert.equal(decision.route.inheritAssigneeFrom, "ENG-9");
  });

  it("asks the model for an area on every triage", () => {
    const questions = triageQuestions(input());
    assert.ok(questions.area);
    assert.ok(questions.area.type === "choice");
  });

  it("allows the label sets the route tool checks", () => {
    assert.equal(developerLabelsAllowed(["Bug"]), true);
    assert.equal(developerLabelsAllowed(["feature request", "approved"]), true);
    assert.equal(developerLabelsAllowed(["Feature Request"]), false);
    assert.equal(developerLabelsAllowed(["Approved"]), false);
    assert.equal(developerLabelsAllowed([]), false);
  });
});

describe("module size", () => {
  it("keeps the decision module under the 1000 line limit by routing ownership elsewhere", () => {
    const lines = readFileSync(
      new URL("./jev-decisions.ts", import.meta.url),
      "utf8"
    ).split("\n").length;
    assert.ok(lines < 1000, `jev-decisions.ts is ${lines} lines`);
  });
});
