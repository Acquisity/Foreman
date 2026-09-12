/**
 * Deterministic measurement of the capability catalog each session lane
 * carries, derived from eve's compiled manifest, the authored session
 * configuration, and the same resolvers eve runs for dynamic capabilities.
 *
 * @remarks
 * This module measures and reports. It gates nothing: the lane differences it
 * observes are the ones the authored configuration already makes. Today those
 * are the repository and GitHub tool catalogs, offered by
 * `repositoryCapabilitiesAvailable` to a lane that has a repository selected
 * (of the three measured lanes, only `repository-interactive`). Reading a
 * lane's numbers must never change
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
 * - The subagent delegation tools eve lowers at runtime. The prepared name,
 *   description, and input schema are read from eve for each compiled subagent,
 *   including the background-task instructions eve appends to its description.
 *
 * eve's own built-in tools (`bash`, `read_file`, and the rest) are identified
 * by framework ownership and excluded from this measurement. They are the same in every
 * lane by construction, so they cannot explain a difference between lanes,
 * which is what this report exists to show.
 */
import { readFileSync } from "node:fs";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
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
import { slackSessionAuth } from "./session-auth.js";

/** The three session lanes the report covers. */
export const CAPABILITY_LANES = [
  "slack",
  "slack-intake-only",
  "repository-interactive",
] as const;

export type CapabilityLane = (typeof CAPABILITY_LANES)[number];

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
export const MEASURED_MANIFEST_VERSION = 48;

const capabilityOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }),
  z.object({ feature: z.string(), kind: z.literal("framework") }),
  z.object({
    kind: z.literal("extension"),
    namespace: z.string(),
    packageName: z.string(),
  }),
]);

type CapabilityOwner = z.infer<typeof capabilityOwnerSchema>;

const compiledSubagentSchema = namedEntrySchema.extend({
  configResolver: z.never().optional(),
  description: z.string(),
  logicalPath: z.string(),
  nodeId: z.string(),
  owner: capabilityOwnerSchema,
  sourceKind: z.literal("module"),
});

type CompiledSubagent = z.infer<typeof compiledSubagentSchema>;

/**
 * Unsupported ownership, dynamic skills/subagents, and remote agents fail
 * instead of producing a partial catalog. Module capabilities get their owner
 * from the binding; directory resources carry it directly in their entry.
 */
export const capabilityManifestSchema = z
  .object({
    appRoot: z.string(),
    bindings: z.record(z.string(), z.object({ owner: capabilityOwnerSchema })),
    dynamicSkills: z
      .array(z.unknown())
      .max(0, "capability-budget.ts does not support dynamic skills.")
      .default([]),
    dynamicTools: z.array(dynamicToolEntrySchema).default([]),
    kind: z.literal(MEASURED_MANIFEST_KIND),
    remoteAgents: z
      .array(z.unknown())
      .max(0, "capability-budget.ts does not support remote agents.")
      .default([]),
    skills: z
      .array(
        namedEntrySchema.extend({
          markdown: z.string().default(""),
          owner: capabilityOwnerSchema,
        })
      )
      .default([]),
    subagents: z.array(compiledSubagentSchema).default([]),
    tools: z
      .array(namedEntrySchema.extend({ inputSchema: z.unknown().optional() }))
      .default([]),
    version: z.literal(MEASURED_MANIFEST_VERSION),
  })
  .superRefine((manifest, ctx) => {
    for (const entry of [...manifest.tools, ...manifest.dynamicTools]) {
      if (!manifest.bindings[entry.sourceId]) {
        ctx.addIssue({
          code: "custom",
          message: `Capability ${entry.sourceId} has no ownership binding.`,
          path: ["bindings", entry.sourceId],
        });
      }
    }
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

/** The repository the repository-selected lane names. */
const MEASURED_REPOSITORY = "Acquisity/Foreman";

/**
 * The auth each lane's channel stamps at dispatch, composed by the same
 * helpers `agent/channels/slack.ts` calls, so a
 * change to either dispatch moves the measurement with it.
 */
const LANE_AUTH: Record<CapabilityLane, () => SessionAuthContext> = {
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

/** One model-visible tool a dynamic tool resolver returned, with its source. */
interface ResolvedDynamicTool extends AdmittedDynamicTool {
  readonly source: string;
}

interface ResolvedSubagentTool extends ResolvedDynamicTool {
  readonly nodeId: string;
}

/** Everything a lane carries that the compiled manifest cannot state. */
export interface ResolvedLaneCapabilities {
  readonly dynamicTools: readonly ResolvedDynamicTool[];
  readonly subagentTools: readonly ResolvedSubagentTool[];
}

// Directory-mounted overrides are application-owned but reach the model under
// the extension's namespace, so they remain in that measured group.
const EXTENSION_OVERRIDE_SOURCE = /^ext-override:([^:]+)/u;

/** Returns the measured group, or null for a framework-owned capability. */
export function capabilitySource(
  sourceId: string,
  owner: CapabilityOwner
): string | null {
  if (owner.kind === "framework") {
    return null;
  }
  if (owner.kind === "extension") {
    return `ext:${owner.namespace}`;
  }
  const namespace = EXTENSION_OVERRIDE_SOURCE.exec(sourceId)?.[1];
  if (namespace) {
    return `ext:${namespace}`;
  }
  const [directory] = sourceId.split("/");
  return `${directory ?? sourceId}/`;
}

const toolSource = (
  manifest: CapabilityManifest,
  sourceId: string
): string | null => {
  const binding = manifest.bindings[sourceId];
  if (!binding) {
    throw new Error(`Capability ${sourceId} has no ownership binding.`);
  }
  return capabilitySource(sourceId, binding.owner);
};

const preparedSubagentSchema = z.object({
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  logicalPath: z.string(),
  name: z.string(),
  nodeId: z.string(),
  sourceId: z.string(),
});

const subagentRegistrySchema = z.object({
  createPreparedRuntimeSubagentTool: z.custom<
    (definition: CompiledSubagent & { kind: "subagent" }) => unknown
  >((value) => typeof value === "function"),
});

/** Reads the actual runtime tool for every compiled static subagent. */
export async function resolveSubagentTools(
  subagents: readonly CompiledSubagent[]
): Promise<ResolvedSubagentTool[]> {
  if (subagents.length === 0) {
    return [];
  }
  const url = new URL(
    "./dist/src/runtime/subagents/registry.js",
    evePackageUrl()
  );
  let module: unknown;
  try {
    module = await import(url.href);
  } catch (error) {
    throw new Error(
      `eve's subagent tool preparation is not readable at ${url.href}.`,
      { cause: error }
    );
  }
  const parsed = subagentRegistrySchema.safeParse(module);
  if (!parsed.success) {
    throw new Error(
      `eve no longer exposes createPreparedRuntimeSubagentTool at ${url.href}, so subagent tools cannot be measured.`
    );
  }
  return subagents.flatMap((subagent) => {
    const source = capabilitySource(subagent.sourceId, subagent.owner);
    if (source === null) {
      return [];
    }
    const prepared = preparedSubagentSchema.parse(
      parsed.data.createPreparedRuntimeSubagentTool({
        ...subagent,
        kind: "subagent",
      })
    );
    return [
      {
        description: prepared.description,
        name: prepared.name,
        nodeId: prepared.nodeId,
        schemaChars: JSON.stringify(prepared.inputSchema).length,
        source,
      },
    ];
  });
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
  const tools = await Promise.all(
    manifest.dynamicTools.map(async (entry) => {
      const source = toolSource(manifest, entry.sourceId);
      if (source === null) {
        return [];
      }
      const admitted = await resolveCompiledDynamicTools(
        entry,
        manifest.appRoot,
        laneSession(lane)
      );
      return admitted.map((tool) => ({ ...tool, source }));
    })
  );
  return {
    dynamicTools: tools.flat(),
    subagentTools: await resolveSubagentTools(manifest.subagents),
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
    ...manifest.tools.flatMap((tool) => {
      const source = toolSource(manifest, tool.sourceId);
      return source === null
        ? []
        : [
            {
              bodyChars: 0,
              descriptionChars: tool.description.length,
              nameChars: tool.name.length,
              schemaChars: schemaChars(tool.inputSchema),
              source,
            },
          ];
    }),
    ...resolved.dynamicTools.map((tool) => ({
      bodyChars: 0,
      descriptionChars: tool.description.length,
      nameChars: tool.name.length,
      schemaChars: tool.schemaChars,
      source: tool.source,
    })),
  ]);
  const skillRows = groupRows(
    "skill",
    manifest.skills.flatMap((skill) => {
      const source = capabilitySource(skill.sourceId, skill.owner);
      return source === null
        ? []
        : [
            {
              bodyChars: skill.markdown.length,
              descriptionChars: skill.description.length,
              nameChars: skill.name.length,
              schemaChars: 0,
              source,
            },
          ];
    })
  );
  const subagentRows = groupRows(
    "subagent",
    resolved.subagentTools.map((subagent) => ({
      bodyChars: 0,
      descriptionChars: subagent.description.length,
      nameChars: subagent.name.length,
      schemaChars: subagent.schemaChars,
      source: subagent.source,
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
  const repositoryLanes = ["repository-interactive"] as const;
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
