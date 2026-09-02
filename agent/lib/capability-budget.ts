/**
 * Deterministic measurement of the capability catalog each session lane
 * carries, derived from eve's compiled manifest, the authored session
 * configuration, and the same resolvers eve runs for dynamic capabilities.
 *
 * @remarks
 * This module measures and reports. It gates nothing: the lane differences it
 * observes are the ones the authored configuration already makes. Today those
 * are the `factory-pipeline` dynamic skill and the repository and GitHub tool
 * catalogs, offered by `factorySkillAvailable` and
 * `repositoryCapabilitiesAvailable` to a lane that has a repository selected
 * or a factory path open to it (of the four measured lanes, only
 * `repository-interactive` and `autonomous-factory`, since none of them
 * carries explicit factory intent). Reading a lane's numbers must never change
 * what that lane may call, and no gate is restated here: a lane that carries
 * nothing from a resolver measures as nothing.
 *
 * Three sources are measured, and every one of them is resolved rather than
 * estimated:
 *
 * - The compiled manifest `.eve/compile/compiled-agent-manifest.json`, written
 *   by `eve info` and `eve build`. It records the authored and mounted surface
 *   eve loads at runtime, so the same source tree always measures the same.
 * - Dynamic capabilities, which appear in the manifest only as a resolver
 *   descriptor. Each descriptor is run through its own authored module, so the
 *   GitHub extension's tools are counted with the names, descriptions, and
 *   schemas the model actually sees. A dynamic tool is counted only after
 *   eve's own runtime preparation admits it, which `eve-dynamic-tools.ts`
 *   drives: the authored modules are bundled with the same transform that
 *   stamps durable callback descriptors in a deployment, and eve's step-time
 *   dispatch checks each entry's `defineTool` brand, validates every durable
 *   callback, qualifies the names, and serializes the schemas. A resolver is counted on the way in as well as on
 *   the way out, so a result eve would drop measures as a failure rather than
 *   as thirty-one model-visible tools, while a lane a resolver deliberately
 *   offers nothing to measures as zero. A descriptor whose module is not in
 *   the bundled module map fails the measurement instead of being reported as
 *   a smaller number.
 * - The subagent delegation tools eve lowers at runtime. Their input schema is
 *   framework-owned and identical for every subagent, so it is read from eve
 *   itself rather than guessed at.
 *
 * eve's own built-in tools (`bash`, `read_file`, and the rest) are outside the
 * compiled manifest and outside this measurement. They are the same in every
 * lane by construction, so they cannot explain a difference between lanes,
 * which is what this report exists to show.
 */
import { readFileSync } from "node:fs";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/skills";
import { z } from "zod";
import factoryPipeline from "../skills/factory-pipeline.js";
import { OWNER_USER_ID, SLACK_TEAM_ID } from "./constants.js";
import type {
  AdmittedDynamicTool,
  DynamicToolSession,
} from "./eve-dynamic-tools.js";
import {
  dynamicToolEntrySchema,
  evePackageUrl,
  installedEveVersion,
  resolveCompiledDynamicTools,
} from "./eve-dynamic-tools.js";
import { githubFactoryAuth, slackSessionAuth } from "./session-auth.js";

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

/** The manifest shape this measurement was written against. */
export const MEASURED_MANIFEST_KIND = "eve-agent-compiled-manifest";

/**
 * The manifest revision this measurement was written against.
 *
 * @remarks
 * Pinned on purpose. A revision bump means eve changed what it records, and
 * the fields read below have to be checked against the new shape before the
 * numbers mean anything. Failing on an unrecognized revision is the point:
 * measuring it anyway would publish a total nobody had verified.
 */
export const MEASURED_MANIFEST_VERSION = 41;

/**
 * The slice of eve's compiled manifest this measurement reads. Unlisted keys
 * are dropped, so a manifest that grows new fields still parses, while a
 * manifest of another kind or revision is rejected outright.
 */
export const capabilityManifestSchema = z.object({
  /** The application root eve compiled, where its authored modules live. */
  appRoot: z.string(),
  config: z
    .object({
      experimental: z
        .object({ subagentPersistentSessions: z.boolean().optional() })
        .optional(),
    })
    .optional(),
  dynamicSkills: z.array(dynamicEntrySchema).default([]),
  dynamicTools: z.array(dynamicToolEntrySchema).default([]),
  kind: z.literal(MEASURED_MANIFEST_KIND),
  skills: z
    .array(namedEntrySchema.extend({ markdown: z.string().default("") }))
    .default([]),
  subagents: z.array(namedEntrySchema).default([]),
  tools: z
    .array(namedEntrySchema.extend({ inputSchema: z.unknown().optional() }))
    .default([]),
  version: z.literal(MEASURED_MANIFEST_VERSION),
});

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

/** Parses a compiled manifest read from disk. Throws on an unusable shape. */
export function parseCapabilityManifest(raw: unknown): CapabilityManifest {
  return capabilityManifestSchema.parse(raw);
}

/** Where `eve info` and `eve build` write the compiled manifest. */
export const COMPILED_MANIFEST_PATH =
  ".eve/compile/compiled-agent-manifest.json";

/** Where the same commands record how that manifest was produced. */
export const COMPILE_METADATA_PATH = ".eve/compile/compile-metadata.json";

const compileMetadataSchema = z.object({
  generator: z.object({ name: z.literal("eve"), version: z.string() }),
  kind: z.literal("eve-compile-metadata"),
  status: z.literal("ready"),
});

const readJsonFile = (path: URL): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

/**
 * Reads the compiled manifest after proving where it came from.
 *
 * @remarks
 * An artifact that exists is not an artifact that describes this tree: a
 * half-written compile, or one left behind by a different eve, would measure a
 * surface the agent no longer has. The compile metadata must report a ready
 * compile from the installed eve, and the manifest itself must be the kind and
 * revision this module reads. Anything else throws, and callers report the
 * failure instead of a number. Freshness against the working tree is the
 * caller's job: `pnpm report:capabilities` compiles immediately before
 * reading, and `pnpm validate` compiles before running the tests.
 */
export function readCompiledManifest(appRoot: URL): CapabilityManifest {
  const metadata = compileMetadataSchema.parse(
    readJsonFile(new URL(COMPILE_METADATA_PATH, appRoot))
  );
  const eveVersion = installedEveVersion();
  if (metadata.generator.version !== eveVersion) {
    throw new Error(
      `${COMPILED_MANIFEST_PATH} was compiled by eve ${metadata.generator.version} but eve ${eveVersion} is installed. Recompile with 'npx eve info'.`
    );
  }
  return parseCapabilityManifest(
    readJsonFile(new URL(COMPILED_MANIFEST_PATH, appRoot))
  );
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

/** The measured catalog for one lane. */
export interface LaneBudget {
  /** Skill markdown, appended only when the model loads the skill. */
  readonly bodyChars: number;
  /** Names, descriptions, and schemas the lane carries on every turn. */
  readonly catalogChars: number;
  readonly lane: CapabilityLane;
  readonly rows: readonly CapabilityRow[];
}

// The Slack author eve projects for a mention in an Acquisity channel, in the
// shape `defaultSlackAuth` builds. Only the shape matters: every lane
// difference below comes from the stamps the authored channels add on top of
// it, which `session-auth.ts` owns for both the channel and this measurement.
const SLACK_AUTH: SessionAuthContext = {
  attributes: {
    author_type: "user",
    channel_id: "C0CAPABILITYBUDGET",
    team_id: SLACK_TEAM_ID,
    thread_ts: "1756000000.000100",
    user_id: OWNER_USER_ID,
  },
  authenticator: "slack-webhook",
  issuer: `slack:${SLACK_TEAM_ID}`,
  principalId: `slack:${SLACK_TEAM_ID}:${OWNER_USER_ID}`,
  principalType: "user",
};

/** The repository the repository-selected and factory lanes name. */
const MEASURED_REPOSITORY = "Acquisity/Foreman";

/** The issue number the measured factory run is dispatched from. */
const MEASURED_INTAKE_ISSUE = 1;

// A signed GitHub webhook sender, in the shape `defaultGitHubAuth` builds,
// before `githubFactoryAuth` rewrites it into the unattended factory
// principal.
const GITHUB_AUTH: SessionAuthContext = {
  attributes: {
    conversation_kind: "issue",
    issue_number: String(MEASURED_INTAKE_ISSUE),
    repository: MEASURED_REPOSITORY,
    user_login: "capability-budget",
    user_type: "User",
  },
  authenticator: "github-webhook",
  issuer: "github:Acquisity",
  principalId: "github:1",
  principalType: "user",
  subject: "capability-budget",
};

/**
 * The auth each lane's channel stamps at dispatch, composed by the same
 * helpers `agent/channels/slack.ts` and `agent/channels/github.ts` call, so a
 * change to either dispatch moves the measurement with it.
 */
const LANE_AUTH: Record<CapabilityLane, () => SessionAuthContext> = {
  "autonomous-factory": () =>
    githubFactoryAuth(GITHUB_AUTH, MEASURED_REPOSITORY, MEASURED_INTAKE_ISSUE),
  "repository-interactive": () =>
    slackSessionAuth(SLACK_AUTH, {
      intakeOnly: false,
      repository: MEASURED_REPOSITORY,
    }),
  slack: () => slackSessionAuth(SLACK_AUTH, { intakeOnly: false }),
  "slack-intake-only": () => slackSessionAuth(SLACK_AUTH, { intakeOnly: true }),
};

/** The session auth a lane runs under. */
export function laneAuth(lane: CapabilityLane): SessionAuthContext {
  return LANE_AUTH[lane]();
}

/** The session a lane's dynamic resolvers are dispatched under. */
const laneSession = (lane: CapabilityLane): DynamicToolSession => ({
  auth: laneAuth(lane),
  id: `capability-budget:${lane}`,
});

const resolveContext = (lane: CapabilityLane): DynamicResolveContext => ({
  channel: { kind: lane === "autonomous-factory" ? "github" : "slack" },
  messages: [],
  session: {
    auth: { current: laneAuth(lane), initiator: laneAuth(lane) },
    id: laneSession(lane).id,
  },
});

/**
 * The authored module behind each compiled dynamic skill, keyed by the source
 * the manifest records.
 *
 * @remarks
 * One entry per dynamic skill in the tree. A compiled entry with no module
 * here is rejected rather than measured with another entry's result, which
 * would report the wrong name, description, and body under the new slug.
 */
const DYNAMIC_SKILL_SOURCES = new Map<string, typeof factoryPipeline>([
  ["skills/factory-pipeline.ts", factoryPipeline],
]);

/** One dynamic skill a lane resolves. */
interface ResolvedDynamicSkill {
  readonly description: string;
  readonly markdown: string;
  readonly slug: string;
  readonly source: string;
}

/** One model-visible tool a dynamic tool resolver returned, with its source. */
interface ResolvedDynamicTool extends AdmittedDynamicTool {
  readonly source: string;
}

/** Everything a lane carries that the compiled manifest cannot state. */
export interface ResolvedLaneCapabilities {
  readonly dynamicSkills: readonly ResolvedDynamicSkill[];
  readonly dynamicTools: readonly ResolvedDynamicTool[];
  /** Input schema characters on each subagent's delegation tool. */
  readonly subagentSchemaChars: number;
}

const dynamicSkillEntry = async (
  entry: z.infer<typeof dynamicEntrySchema>,
  lane: CapabilityLane
): Promise<ResolvedDynamicSkill | null> => {
  const module = DYNAMIC_SKILL_SOURCES.get(entry.sourceId);
  if (!module) {
    throw new Error(
      `Dynamic skill '${entry.slug}' from ${entry.sourceId} has no resolver registered in capability-budget.ts, so its catalog cost cannot be measured.`
    );
  }
  // Resolvers run at session, turn, or step scope; the compiled entry names
  // the events this one handles, and the first non-nil result in that order is
  // what the lane carries.
  const resolutions = await Promise.all(
    entry.eventNames.map((eventName) => {
      const resolve = module.events[eventName as keyof typeof module.events];
      if (!resolve) {
        throw new Error(
          `Dynamic skill '${entry.slug}' compiled for '${eventName}' but its module has no such resolver.`
        );
      }
      return resolve({}, resolveContext(lane));
    })
  );
  for (const resolution of resolutions) {
    const parsed = resolvedSkillSchema.safeParse(resolution);
    if (parsed.success) {
      return {
        ...parsed.data,
        slug: entry.slug,
        source: capabilitySource(entry.sourceId),
      };
    }
  }
  return null;
};

// `ext-override:` is the same extension, mounted as a directory so the
// consumer can replace one of its contributions. The tools still reach the
// model under the extension's namespace, so they are reported under it too.
const EXTENSION_SOURCE = /^ext(?:-override)?:([^:]+)/u;

/**
 * The source a capability came from: an extension namespace such as
 * `ext:browser`, or the authored directory such as `tools/`.
 */
export function capabilitySource(sourceId: string): string {
  const namespace = EXTENSION_SOURCE.exec(sourceId)?.[1];
  if (namespace) {
    return `ext:${namespace}`;
  }
  const [directory] = sourceId.split("/");
  return `${directory ?? sourceId}/`;
}

const eveSubagentRegistryUrl = (): URL =>
  new URL("./dist/src/runtime/subagents/registry.js", evePackageUrl());

const subagentRegistrySchema = z.object({
  getSubagentToolInputJsonSchema: z.custom<(persistent: boolean) => unknown>(
    (value) => typeof value === "function"
  ),
});

/**
 * The characters every subagent's delegation tool carries in its input schema.
 *
 * @remarks
 * eve lowers one fixed schema onto every subagent tool, so it is framework
 * cost rather than authored cost, and it appears nowhere in the compiled
 * manifest. It is read from the installed eve instead of restated here: a
 * copied schema would keep reporting the old number after eve changed the real
 * one. If eve stops exposing it, this throws and no total is published.
 */
export async function subagentDelegationSchemaChars(
  persistentSessions: boolean
): Promise<number> {
  const url = eveSubagentRegistryUrl();
  let module: unknown;
  try {
    module = await import(url.href);
  } catch (error) {
    throw new Error(
      `eve's subagent delegation schema is not readable at ${url.href}.`,
      { cause: error }
    );
  }
  const parsed = subagentRegistrySchema.safeParse(module);
  if (!parsed.success) {
    throw new Error(
      `eve no longer exposes getSubagentToolInputJsonSchema at ${url.href}, so subagent schema characters cannot be measured.`
    );
  }
  return JSON.stringify(
    parsed.data.getSubagentToolInputJsonSchema(persistentSessions)
  ).length;
}

/**
 * Resolves everything one lane carries that the compiled manifest states only
 * as a descriptor. Throws when any compiled dynamic entry has no resolver, so
 * a partial catalog is never published as a whole one.
 */
export async function resolveLaneCapabilities(
  manifest: CapabilityManifest,
  lane: CapabilityLane
): Promise<ResolvedLaneCapabilities> {
  const skills = await Promise.all(
    manifest.dynamicSkills.map((entry) => dynamicSkillEntry(entry, lane))
  );
  const tools = await Promise.all(
    manifest.dynamicTools.map(async (entry) => {
      const admitted = await resolveCompiledDynamicTools(
        entry,
        manifest.appRoot,
        laneSession(lane)
      );
      const source = capabilitySource(entry.sourceId);
      return admitted.map((tool) => ({ ...tool, source }));
    })
  );
  return {
    dynamicSkills: skills.filter((skill) => skill !== null),
    dynamicTools: tools.flat(),
    subagentSchemaChars: await subagentDelegationSchemaChars(
      manifest.config?.experimental?.subagentPersistentSessions === true
    ),
  };
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
 * @param resolved - What this lane's dynamic resolvers returned, from
 * {@link resolveLaneCapabilities}. Passed in so the measurement itself stays a
 * pure function of the manifest and the resolved configuration.
 */
export function measureLane(
  manifest: CapabilityManifest,
  lane: CapabilityLane,
  resolved: ResolvedLaneCapabilities
): LaneBudget {
  const toolRows = groupRows("tool", [
    ...manifest.tools.map((tool) => ({
      bodyChars: 0,
      descriptionChars: tool.description.length,
      nameChars: tool.name.length,
      schemaChars: schemaChars(tool.inputSchema),
      source: capabilitySource(tool.sourceId),
    })),
    ...resolved.dynamicTools.map((tool) => ({
      bodyChars: 0,
      descriptionChars: tool.description.length,
      nameChars: tool.name.length,
      schemaChars: tool.schemaChars,
      source: tool.source,
    })),
  ]);
  const skillRows = groupRows("skill", [
    ...manifest.skills.map((skill) => ({
      bodyChars: skill.markdown.length,
      descriptionChars: skill.description.length,
      nameChars: skill.name.length,
      schemaChars: 0,
      source: capabilitySource(skill.sourceId),
    })),
    ...resolved.dynamicSkills.map((skill) => ({
      bodyChars: skill.markdown.length,
      descriptionChars: skill.description.length,
      nameChars: skill.slug.length,
      schemaChars: 0,
      source: skill.source,
    })),
  ]);
  const subagentRows = groupRows(
    "subagent",
    manifest.subagents.map((subagent) => ({
      bodyChars: 0,
      descriptionChars: subagent.description.length,
      nameChars: subagent.name.length,
      schemaChars: resolved.subagentSchemaChars,
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
  };
}

/** Measures every lane against one compiled manifest. */
export async function measureCapabilityBudget(
  manifest: CapabilityManifest
): Promise<LaneBudget[]> {
  const resolved = await Promise.all(
    CAPABILITY_LANES.map((lane) => resolveLaneCapabilities(manifest, lane))
  );
  return CAPABILITY_LANES.map((lane, index) => {
    const laneCapabilities = resolved[index];
    if (!laneCapabilities) {
      throw new Error(`Lane ${lane} resolved no capability set.`);
    }
    return measureLane(manifest, lane, laneCapabilities);
  });
}

/**
 * Characters per token used for the estimates the report prints.
 *
 * @remarks
 * A deliberate approximation: the catalog is English descriptions and JSON
 * schemas, which current tokenizers encode at roughly this density. No
 * tokenizer is installed, and estimating with one would tie the number to one
 * provider. The character counts are the measurement; the token figure only
 * makes them legible.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** The approximate tokens a character count costs on each model call. */
export const estimateTokens = (chars: number): number =>
  Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);

/** Ordinary Slack's catalog as a share of a repository-carrying lane's. */
export const ordinarySlackShare = (
  budgets: readonly LaneBudget[],
  againstLane: CapabilityLane = "repository-interactive"
): number | null => {
  const chars = (lane: CapabilityLane) =>
    budgets.find((budget) => budget.lane === lane)?.catalogChars;
  const slack = chars("slack");
  const repositoryLane = chars(againstLane);
  return slack === undefined || !repositoryLane ? null : slack / repositoryLane;
};

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
    "Catalog characters ride every turn: names, descriptions, and input",
    "schemas, including the tools an extension resolves at runtime and the",
    "delegation schema eve lowers onto every subagent. Body characters are",
    "skill markdown, appended only when the model loads that skill. Token",
    `figures divide characters by ${CHARS_PER_TOKEN_ESTIMATE} and are estimates. eve's own built-in`,
    "tools are identical in every lane and are not measured here; they and the",
    "other framework-owned catalogs no lane can shed are listed in",
    ".github/EVE-PROPOSALS.md.",
  ];
  for (const budget of budgets) {
    lines.push(
      "",
      `## ${budget.lane}`,
      "",
      ...renderTable(budget.rows.map(rowCells)),
      "",
      `catalog ${budget.catalogChars} characters (about ${estimateTokens(budget.catalogChars)} tokens), body ${budget.bodyChars} characters`
    );
  }
  const repositoryLanes = [
    "repository-interactive",
    "autonomous-factory",
  ] as const;
  const shares = repositoryLanes.flatMap((lane) => {
    const share = ordinarySlackShare(budgets, lane);
    return share === null ? [] : [[lane, share] as const];
  });
  if (shares.length > 0) {
    lines.push("", "## Ordinary Slack against repository-carrying lanes", "");
    for (const [lane, share] of shares) {
      lines.push(
        `slack carries ${(share * 100).toFixed(1)}% of the ${lane} catalog. The regression test in capability-budget.test.ts holds this share at or below its ceiling.`
      );
    }
  }
  return lines.join("\n");
}
