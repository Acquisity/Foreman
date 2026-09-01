/**
 * Deterministic measurement of the capability catalog each session lane
 * carries, derived from eve's compiled manifest and the authored session
 * configuration.
 *
 * @remarks
 * This module measures and reports. It gates nothing: every lane sees the
 * same authored tools, skills, and subagents that eve compiles today, and the
 * only lane difference it can observe is one the authored configuration
 * already makes (the `factory-pipeline` dynamic skill, which resolves to null
 * for an unattended factory run). Reading a lane's numbers must never change
 * what that lane may call.
 *
 * The compiled manifest is `.eve/compile/compiled-agent-manifest.json`,
 * written by `eve info` and `eve build`. It records the authored surface eve
 * loads at runtime, so the same source tree always measures the same. A
 * dynamic tool appears there only as its resolver descriptor: the GitHub
 * extension's 31 entries resolve inside eve at `step.started` and are not in
 * the manifest, so they are reported as unresolved rather than guessed at.
 */
import { readFileSync } from "node:fs";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/skills";
import { z } from "zod";
import factoryPipeline from "../skills/factory-pipeline.js";
import { OWNER_USER_ID, SLACK_TEAM_ID } from "./constants.js";
import { stampRepository } from "./repository.js";
import {
  stampAutonomous,
  stampIntakeOnly,
  stampInvestigationMemory,
  stampTrusted,
} from "./trust.js";

/** The four session lanes the report covers. */
export const CAPABILITY_LANES = [
  "slack",
  "slack-intake-only",
  "repository-interactive",
  "autonomous-factory",
] as const;

export type CapabilityLane = (typeof CAPABILITY_LANES)[number];

const dynamicEntrySchema = z.object({
  eventNames: z.array(z.string()).default([]),
  slug: z.string(),
  sourceId: z.string(),
});

const namedEntrySchema = z.object({
  description: z.string().default(""),
  name: z.string(),
  sourceId: z.string(),
});

/**
 * The slice of eve's compiled manifest this measurement reads. Unlisted keys
 * are dropped, so a manifest that grows new fields still parses.
 */
export const capabilityManifestSchema = z.object({
  dynamicSkills: z.array(dynamicEntrySchema).default([]),
  dynamicTools: z.array(dynamicEntrySchema).default([]),
  skills: z
    .array(namedEntrySchema.extend({ markdown: z.string().default("") }))
    .default([]),
  subagents: z.array(namedEntrySchema).default([]),
  tools: z
    .array(namedEntrySchema.extend({ inputSchema: z.unknown().optional() }))
    .default([]),
});

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

/** Parses a compiled manifest read from disk. Throws on an unusable shape. */
export function parseCapabilityManifest(raw: unknown): CapabilityManifest {
  return capabilityManifestSchema.parse(raw);
}

/** Where `eve info` and `eve build` write the compiled manifest. */
export const COMPILED_MANIFEST_PATH =
  ".eve/compile/compiled-agent-manifest.json";

/**
 * Reads the compiled manifest, or returns null when it has not been written
 * yet. A fresh checkout has no `.eve/`, so callers report that rather than
 * measuring a surface that was never compiled.
 */
export function readCompiledManifest(appRoot: URL): CapabilityManifest | null {
  try {
    return parseCapabilityManifest(
      JSON.parse(readFileSync(new URL(COMPILED_MANIFEST_PATH, appRoot), "utf8"))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** What a dynamic skill resolver returns when it offers the lane a skill. */
const resolvedSkillSchema = z.object({
  description: z.string().default(""),
  markdown: z.string().default(""),
});

export type CapabilityKind = "tool" | "skill" | "subagent";

/** One measured group of capabilities: one kind from one source. */
export interface CapabilityRow {
  readonly bodyChars: number;
  readonly descriptionChars: number;
  readonly entries: number;
  readonly kind: CapabilityKind;
  readonly nameChars: number;
  readonly schemaChars: number;
  readonly source: string;
}

/** A capability source the compiled manifest cannot measure. */
export interface UnresolvedSource {
  readonly events: readonly string[];
  readonly kind: CapabilityKind;
  readonly slug: string;
  readonly source: string;
}

/** The measured catalog for one lane. */
export interface LaneBudget {
  /** Skill markdown, appended only when the model loads the skill. */
  readonly bodyChars: number;
  /** Names, descriptions, and schemas the lane carries on every turn. */
  readonly catalogChars: number;
  readonly lane: CapabilityLane;
  readonly rows: readonly CapabilityRow[];
  readonly unresolved: readonly UnresolvedSource[];
}

// The Slack author eve projects for a mention in an Acquisity channel. Only
// the shape matters: every lane difference below comes from the stamps the
// authored channels add on top of it.
const SLACK_AUTH: SessionAuthContext = {
  attributes: {
    author_type: "user",
    channel_id: "C0CAPABILITYBUDGET",
    team_id: SLACK_TEAM_ID,
    user_id: OWNER_USER_ID,
  },
  authenticator: "slack-webhook",
  principalId: `slack:${SLACK_TEAM_ID}:${OWNER_USER_ID}`,
  principalType: "user",
};

// A signed GitHub webhook sender, before `agent/channels/github.ts` rewrites
// it into the unattended factory principal.
const GITHUB_AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "github-webhook",
  principalId: "github:1",
  principalType: "user",
};

/** The repository the repository-selected lane names in its request. */
const MEASURED_REPOSITORY = "Acquisity/Foreman";

const attendedSlackAuth = (): SessionAuthContext =>
  stampInvestigationMemory(stampTrusted(SLACK_AUTH));

/**
 * The auth context each lane's channel stamps at dispatch, built from the
 * same helpers `agent/channels/slack.ts` and `agent/channels/github.ts` use,
 * so a change to either one moves the measurement with it.
 */
const LANE_AUTH: Record<CapabilityLane, () => SessionAuthContext> = {
  "autonomous-factory": () => stampAutonomous(stampTrusted(GITHUB_AUTH), 1),
  "repository-interactive": () =>
    stampRepository(attendedSlackAuth(), MEASURED_REPOSITORY, "explicit"),
  slack: attendedSlackAuth,
  "slack-intake-only": () => stampIntakeOnly(attendedSlackAuth()),
};

/** The session auth a lane runs under. */
export function laneAuth(lane: CapabilityLane): SessionAuthContext {
  return LANE_AUTH[lane]();
}

const resolveContext = (lane: CapabilityLane): DynamicResolveContext => ({
  channel: { kind: lane === "autonomous-factory" ? "github" : "slack" },
  messages: [],
  session: {
    auth: { current: laneAuth(lane), initiator: laneAuth(lane) },
    id: `capability-budget:${lane}`,
  },
});

/** A dynamic skill this lane resolves, or null when the lane gets none. */
export async function resolveFactoryPipelineSkill(
  lane: CapabilityLane
): Promise<z.infer<typeof resolvedSkillSchema> | null> {
  const resolve = factoryPipeline.events["turn.started"];
  if (!resolve) {
    return null;
  }
  const resolved = await resolve({}, resolveContext(lane));
  const parsed = resolvedSkillSchema.safeParse(resolved);
  return parsed.success ? parsed.data : null;
}

const EXTENSION_SOURCE = /^(ext:[^:]+)/u;

/**
 * The source a capability came from: an extension namespace such as
 * `ext:browser`, or the authored directory such as `tools/`.
 */
export function capabilitySource(sourceId: string): string {
  const extension = EXTENSION_SOURCE.exec(sourceId);
  if (extension?.[1]) {
    return extension[1];
  }
  const [directory] = sourceId.split("/");
  return `${directory ?? sourceId}/`;
}

interface MeasuredEntry {
  readonly bodyChars: number;
  readonly descriptionChars: number;
  readonly nameChars: number;
  readonly schemaChars: number;
  readonly source: string;
}

const schemaChars = (schema: unknown): number =>
  schema === undefined ? 0 : JSON.stringify(schema).length;

const groupRows = (
  kind: CapabilityKind,
  entries: readonly MeasuredEntry[]
): CapabilityRow[] => {
  const bySource = new Map<string, CapabilityRow>();
  for (const entry of entries) {
    const current = bySource.get(entry.source);
    bySource.set(entry.source, {
      bodyChars: (current?.bodyChars ?? 0) + entry.bodyChars,
      descriptionChars:
        (current?.descriptionChars ?? 0) + entry.descriptionChars,
      entries: (current?.entries ?? 0) + 1,
      kind,
      nameChars: (current?.nameChars ?? 0) + entry.nameChars,
      schemaChars: (current?.schemaChars ?? 0) + entry.schemaChars,
      source: entry.source,
    });
  }
  return [...bySource.values()].sort((a, b) =>
    a.source.localeCompare(b.source)
  );
};

/**
 * Measures one lane's catalog.
 *
 * @param manifest - The parsed compiled manifest.
 * @param lane - The lane to measure.
 * @param dynamicSkill - What the lane's dynamic skill resolvers returned, from
 * {@link resolveFactoryPipelineSkill}. Passed in so the measurement itself
 * stays a pure function of the manifest and the resolved configuration.
 */
export function measureLane(
  manifest: CapabilityManifest,
  lane: CapabilityLane,
  dynamicSkill: z.infer<typeof resolvedSkillSchema> | null
): LaneBudget {
  const toolRows = groupRows(
    "tool",
    manifest.tools.map((tool) => ({
      bodyChars: 0,
      descriptionChars: tool.description.length,
      nameChars: tool.name.length,
      schemaChars: schemaChars(tool.inputSchema),
      source: capabilitySource(tool.sourceId),
    }))
  );
  const dynamicSkillEntries = manifest.dynamicSkills.flatMap((entry) =>
    dynamicSkill === null
      ? []
      : [
          {
            bodyChars: dynamicSkill.markdown.length,
            descriptionChars: dynamicSkill.description.length,
            nameChars: entry.slug.length,
            schemaChars: 0,
            source: `dynamic:${entry.slug}`,
          },
        ]
  );
  const skillRows = groupRows("skill", [
    ...manifest.skills.map((skill) => ({
      bodyChars: skill.markdown.length,
      descriptionChars: skill.description.length,
      nameChars: skill.name.length,
      schemaChars: 0,
      source: capabilitySource(skill.sourceId),
    })),
    ...dynamicSkillEntries,
  ]);
  const subagentRows = groupRows(
    "subagent",
    manifest.subagents.map((subagent) => ({
      bodyChars: 0,
      descriptionChars: subagent.description.length,
      nameChars: subagent.name.length,
      schemaChars: 0,
      source: capabilitySource(subagent.sourceId),
    }))
  );
  const rows = [...toolRows, ...skillRows, ...subagentRows];
  return {
    bodyChars: rows.reduce((total, row) => total + row.bodyChars, 0),
    catalogChars: rows.reduce(
      (total, row) =>
        total + row.nameChars + row.descriptionChars + row.schemaChars,
      0
    ),
    lane,
    rows,
    unresolved: manifest.dynamicTools.map((entry) => ({
      events: entry.eventNames,
      kind: "tool" as const,
      slug: entry.slug,
      source: capabilitySource(entry.sourceId),
    })),
  };
}

/** Measures every lane against one compiled manifest. */
export async function measureCapabilityBudget(
  manifest: CapabilityManifest
): Promise<LaneBudget[]> {
  const skills = await Promise.all(
    CAPABILITY_LANES.map((lane) => resolveFactoryPipelineSkill(lane))
  );
  return CAPABILITY_LANES.map((lane, index) =>
    measureLane(manifest, lane, skills[index] ?? null)
  );
}

const COLUMNS = [
  "kind",
  "source",
  "entries",
  "name",
  "description",
  "schema",
  "catalog",
  "body",
] as const;

const rowCells = (row: CapabilityRow): string[] => [
  row.kind,
  row.source,
  String(row.entries),
  String(row.nameChars),
  String(row.descriptionChars),
  String(row.schemaChars),
  String(row.nameChars + row.descriptionChars + row.schemaChars),
  String(row.bodyChars),
];

const renderTable = (rows: readonly string[][]): string[] => {
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length))
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(COLUMNS), ...rows.map(line)];
};

/** Renders the measured lanes as a plain-text report. */
export function formatCapabilityBudget(budgets: readonly LaneBudget[]): string {
  const lines = [
    "Capability catalog by session lane",
    "",
    "Catalog characters ride every turn. Body characters are skill markdown,",
    "appended only when the model loads that skill. Subagent tool schemas are",
    "framework-generated and are not in the compiled manifest, so they count 0.",
  ];
  for (const budget of budgets) {
    lines.push(
      "",
      `## ${budget.lane}`,
      "",
      ...renderTable(budget.rows.map(rowCells)),
      "",
      `catalog ${budget.catalogChars} characters, body ${budget.bodyChars} characters`
    );
    for (const entry of budget.unresolved) {
      lines.push(
        `unresolved ${entry.kind} ${entry.slug} from ${entry.source}, resolved at ${entry.events.join(", ")}`
      );
    }
  }
  return lines.join("\n");
}
