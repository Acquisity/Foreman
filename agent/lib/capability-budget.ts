/**
 * Deterministic measurement of the capability catalog each session lane
 * carries, derived from eve's compiled manifest, the authored session
 * configuration, and the same resolvers eve runs for dynamic capabilities.
 *
 * @remarks
 * This module measures and reports. It gates nothing: every lane sees the
 * same authored tools, skills, and subagents that eve compiles today, and the
 * only lane difference it can observe is one the authored configuration
 * already makes (the `factory-pipeline` dynamic skill, which resolves to null
 * for an unattended factory run). Reading a lane's numbers must never change
 * what that lane may call.
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
 *   eve's own runtime preparation admits it: the authored modules are bundled
 *   with the same transform that stamps durable callback descriptors in a
 *   deployment, and eve's step-time dispatch checks each entry's `defineTool`
 *   brand, validates every durable callback, qualifies the names, and
 *   serializes the schemas. A result eve would drop measures as a failure,
 *   never as thirty-one model-visible tools. A descriptor with no registered
 *   resolver fails the measurement instead of being reported as a smaller
 *   number.
 * - The subagent delegation tools eve lowers at runtime. Their input schema is
 *   framework-owned and identical for every subagent, so it is read from eve
 *   itself rather than guessed at.
 *
 * eve's own built-in tools (`bash`, `read_file`, and the rest) are outside the
 * compiled manifest and outside this measurement. They are the same in every
 * lane by construction, so they cannot explain a difference between lanes,
 * which is what this report exists to show.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/skills";
import { z } from "zod";
import factoryPipeline from "../skills/factory-pipeline.js";
import { OWNER_USER_ID, SLACK_TEAM_ID } from "./constants.js";
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

/**
 * A compiled dynamic tool, in the shape eve's own resolver takes: the module
 * it loads, the export it reads, and the extension namespace it prefixes
 * tool names with.
 */
const dynamicToolEntrySchema = dynamicEntrySchema.extend({
  exportName: z.string().optional(),
  extensionNamespace: z.string().optional(),
  logicalPath: z.string(),
  sourceKind: z.literal("module"),
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

/** Where the same commands write the module map the manifest's sources load through. */
const COMPILED_MODULE_MAP_PATH = ".eve/compile/module-map.mjs";

/** eve's own cache for bundled authored modules, which it evaluates from disk. */
const AUTHORED_MODULE_CACHE_PATH = "node_modules/.cache/eve/authored-modules";

const compileMetadataSchema = z.object({
  generator: z.object({ name: z.literal("eve"), version: z.string() }),
  kind: z.literal("eve-compile-metadata"),
  status: z.literal("ready"),
});

const requireFromHere = createRequire(import.meta.url);

/** The eve package this process would run, resolved from node_modules. */
const evePackageUrl = (): URL =>
  pathToFileURL(requireFromHere.resolve("eve/package.json"));

const installedEveVersion = (): string =>
  z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(evePackageUrl(), "utf8"))).version;

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

const resolveContext = (lane: CapabilityLane): DynamicResolveContext => ({
  channel: { kind: lane === "autonomous-factory" ? "github" : "slack" },
  messages: [],
  session: {
    auth: { current: laneAuth(lane), initiator: laneAuth(lane) },
    id: `capability-budget:${lane}`,
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

/** One model-visible tool a dynamic tool resolver returned. */
interface ResolvedDynamicTool {
  readonly description: string;
  readonly name: string;
  readonly schemaChars: number;
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

const EXTENSION_SOURCE = /^(ext:([^:]+))/u;

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

const isFunction = (value: unknown): boolean => typeof value === "function";

/**
 * Loads one of eve's runtime modules by path and checks it exposes what this
 * measurement calls.
 *
 * @remarks
 * eve's dynamic-tool preparation is not on its package exports map, so it is
 * read from the installed package the way the subagent delegation schema is.
 * A module eve moves or reshapes fails here with the path that broke, rather
 * than measuring something else.
 */
const eveRuntimeModule = async <T extends z.ZodType>(
  path: string,
  shape: T
): Promise<z.infer<T>> => {
  const url = new URL(path, evePackageUrl());
  let module: unknown;
  try {
    module = await import(url.href);
  } catch (error) {
    throw new Error(`eve's ${path} is not readable at ${url.href}.`, {
      cause: error,
    });
  }
  const parsed = shape.safeParse(module);
  if (!parsed.success) {
    throw new Error(
      `eve no longer exposes what capability-budget.ts calls at ${url.href}, so dynamic tools cannot be measured.`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
};

const eveFunction = z.custom<(...args: unknown[]) => unknown>(isFunction);

/** The compiled module map eve resolves authored sources through. */
const compiledModuleMapSchema = z.object({
  nodes: z.record(
    z.string(),
    z.object({ modules: z.record(z.string(), z.unknown()) })
  ),
});

type CompiledModuleMap = z.infer<typeof compiledModuleMapSchema>;

/**
 * Bundles and evaluates the authored module map the way eve prepares a
 * development generation, once per application root.
 *
 * @remarks
 * This is the one step that makes durable callback descriptors observable.
 * eve stamps them with a source transform that runs when it bundles the
 * authored modules for a deployment or a development generation, never when
 * the same files are imported directly. `prepareMaterializedAuthoredModules`
 * is eve's bundling entry point and applies that transform along with the
 * extension mount scoping, so the evaluated modules carry exactly the
 * callbacks a deployment carries. The bundle is written to eve's own cache for
 * bundled authored modules and imported from there, as eve does, so its
 * package imports resolve. Evaluating it runs the top level of every authored
 * module, which is what `eve info` does too, so it needs the same environment.
 */
const authoredModuleMaps = new Map<string, Promise<CompiledModuleMap>>();

const loadAuthoredModuleMapOnce = async (
  appRoot: string
): Promise<CompiledModuleMap> => {
  const [
    { loadCompiledManifest },
    { createDiskRuntimeCompiledArtifactsSource },
  ] = await Promise.all([
    eveRuntimeModule(
      "./dist/src/runtime/loaders/manifest.js",
      z.object({ loadCompiledManifest: eveFunction })
    ),
    eveRuntimeModule(
      "./dist/src/runtime/compiled-artifacts-source.js",
      z.object({ createDiskRuntimeCompiledArtifactsSource: eveFunction })
    ),
  ]);
  const { prepareMaterializedAuthoredModules } = await eveRuntimeModule(
    "./dist/src/internal/materialized-authored-modules.js",
    z.object({ prepareMaterializedAuthoredModules: eveFunction })
  );
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
  });
  const { moduleMapCode } = z.object({ moduleMapCode: z.string() }).parse(
    await prepareMaterializedAuthoredModules({
      manifest,
      moduleMapPath: join(appRoot, COMPILED_MODULE_MAP_PATH),
    })
  );
  const hash = createHash("sha256").update(moduleMapCode).digest("hex");
  const directory = join(appRoot, AUTHORED_MODULE_CACHE_PATH);
  const file = join(directory, `capability-budget-${hash}.mjs`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, moduleMapCode);
  const loaded: unknown = await import(`${pathToFileURL(file).href}?v=${hash}`);
  return compiledModuleMapSchema.parse(
    z.object({ moduleMap: z.unknown() }).parse(loaded).moduleMap
  );
};

const loadAuthoredModuleMap = (appRoot: string): Promise<CompiledModuleMap> => {
  const cached = authoredModuleMaps.get(appRoot);
  if (cached) {
    return cached;
  }
  const loading = loadAuthoredModuleMapOnce(appRoot);
  authoredModuleMaps.set(appRoot, loading);
  return loading;
};

/**
 * A compiled dynamic tool with its event handlers reattached, in the shape
 * eve's dynamic-tool lifecycle dispatches.
 */
export interface DynamicToolResolver {
  readonly eventNames: readonly string[];
  readonly events: Readonly<
    Record<string, (event: unknown, ctx: unknown) => unknown>
  >;
  readonly exportName?: string;
  /** Tool names from an extension are prefixed `${extensionNamespace}__`. */
  readonly extensionNamespace?: string;
  readonly logicalPath: string;
  readonly slug: string;
  readonly sourceId: string;
  readonly sourceKind: "module";
}

const dynamicToolResolverSchema = z.custom<DynamicToolResolver>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as DynamicToolResolver).slug === "string" &&
    typeof (value as DynamicToolResolver).events === "object"
);

/** One dynamic tool eve admitted, as it records it for the model call. */
const admittedToolSchema = z.object({
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  name: z.string(),
});

/** A key into eve's execution context. */
const contextKeySchema = z.custom<object>(
  (value) => typeof value === "object" && value !== null
);

interface EveContext {
  readonly get: (key: object) => unknown;
  readonly set: (key: object, value: unknown) => unknown;
}

/**
 * Admits a dynamic tool resolver's result the way eve does before a model
 * call, and returns only what eve admitted.
 *
 * @remarks
 * This is eve's `step.started` dispatch, run against a fresh execution
 * context: eve calls the resolver, requires every entry to be a `defineTool`,
 * validates the durable descriptor on each execute, approval, and model-output
 * callback, prefixes an extension's tool names with its namespace, and
 * serializes each input schema the way it is sent to the model. eve drops a
 * resolver's complete result when any entry fails, logging the reason on its
 * `dynamic-tools` logger, so a dropped result surfaces here as an empty
 * admission and the measurement fails instead of publishing a total for tools
 * the model would never see.
 *
 * @param resolver - The compiled dynamic tool with its handlers attached.
 * @param lane - The lane whose session auth the resolver sees.
 * @param source - The source the admitted tools are reported under.
 */
export async function admitDynamicTools(
  resolver: DynamicToolResolver,
  lane: CapabilityLane,
  source: string
): Promise<ResolvedDynamicTool[]> {
  const [{ ContextContainer }, keys, { dispatchDynamicToolEvent }] =
    await Promise.all([
      eveRuntimeModule(
        "./dist/src/context/container.js",
        z.object({
          ContextContainer: z.custom<new () => EveContext>(isFunction),
        })
      ),
      eveRuntimeModule(
        "./dist/src/context/keys.js",
        z.object({
          AuthKey: contextKeySchema,
          InitiatorAuthKey: contextKeySchema,
          SessionIdKey: contextKeySchema,
          StepDynamicToolMetadataKey: contextKeySchema,
        })
      ),
      eveRuntimeModule(
        "./dist/src/context/dynamic-tool-lifecycle.js",
        z.object({ dispatchDynamicToolEvent: eveFunction })
      ),
    ]);
  const ctx = new ContextContainer();
  const auth = laneAuth(lane);
  ctx.set(keys.SessionIdKey, `capability-budget:${lane}`);
  ctx.set(keys.AuthKey, auth);
  ctx.set(keys.InitiatorAuthKey, auth);
  await dispatchDynamicToolEvent({
    ctx,
    event: { type: "step.started" },
    messages: [],
    resolvers: [resolver],
  });
  const admitted = admittedToolSchema
    .array()
    .parse(ctx.get(keys.StepDynamicToolMetadataKey) ?? []);
  if (admitted.length === 0) {
    throw new Error(
      `eve admitted none of the tools '${resolver.slug}' resolves at step.started, so the catalog cannot be measured. eve drops a resolver's whole result when an entry is not a defineTool() or one of its callbacks has no durable descriptor; its dynamic-tools log line names the entry.`
    );
  }
  return admitted.map((tool) => ({
    description: tool.description,
    name: tool.name,
    // Serialized by eve without the dialect keyword, as the model sees it.
    schemaChars: JSON.stringify(tool.inputSchema).length,
    source,
  }));
}

/**
 * Resolves the GitHub extension's tool surface the way eve does at
 * `step.started`: the compiled entry is loaded from the bundled module map, so
 * the authored mount in `agent/extensions/github.ts` binds its allowlist and
 * overrides at bundle time, and eve's dispatch admits one tool per included
 * entry. Nothing leaves the process; the credential is resolved per call at
 * execution time, which this never reaches.
 */
const resolveGitHubExtensionToolsOnce = async (
  entry: z.infer<typeof dynamicToolEntrySchema>,
  appRoot: string,
  lane: CapabilityLane
): Promise<ResolvedDynamicTool[]> => {
  const [moduleMap, { resolveDynamicToolDefinition }] = await Promise.all([
    loadAuthoredModuleMap(appRoot),
    eveRuntimeModule(
      "./dist/src/runtime/resolve-dynamic-tool.js",
      z.object({ resolveDynamicToolDefinition: eveFunction })
    ),
  ]);
  const resolver = dynamicToolResolverSchema.parse(
    await resolveDynamicToolDefinition(entry, moduleMap, undefined)
  );
  return admitDynamicTools(resolver, lane, capabilitySource(entry.sourceId));
};

/**
 * The extension resolver runs once per lane, compiled entry, and application
 * root. Repeated measurements of that same lane share the result.
 */
const gitHubExtensionTools = new Map<string, Promise<ResolvedDynamicTool[]>>();

/** Complete identity of one lane's compiled dynamic-tool resolution. */
export const dynamicToolCacheKey = (
  entry: z.infer<typeof dynamicToolEntrySchema>,
  appRoot: string,
  lane: CapabilityLane
): string =>
  JSON.stringify([
    appRoot,
    lane,
    {
      eventNames: entry.eventNames,
      exportName: entry.exportName ?? null,
      extensionNamespace: entry.extensionNamespace ?? null,
      logicalPath: entry.logicalPath,
      slug: entry.slug,
      sourceId: entry.sourceId,
      sourceKind: entry.sourceKind,
    },
  ]);

const resolveGitHubExtensionTools = (
  entry: z.infer<typeof dynamicToolEntrySchema>,
  appRoot: string,
  lane: CapabilityLane
): Promise<ResolvedDynamicTool[]> => {
  const key = dynamicToolCacheKey(entry, appRoot, lane);
  const cached = gitHubExtensionTools.get(key);
  if (cached) {
    return cached;
  }
  const loading = resolveGitHubExtensionToolsOnce(entry, appRoot, lane);
  gitHubExtensionTools.set(key, loading);
  return loading;
};

/**
 * The resolver behind each compiled dynamic tool, keyed by the source the
 * manifest records. A compiled entry with no resolver here fails the
 * measurement rather than leaving the lane's largest tool source uncounted.
 */
const DYNAMIC_TOOL_SOURCES = new Map<
  string,
  (
    entry: z.infer<typeof dynamicToolEntrySchema>,
    appRoot: string,
    lane: CapabilityLane
  ) => Promise<ResolvedDynamicTool[]>
>([["ext:github:tools/github.mjs", resolveGitHubExtensionTools]]);

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
    manifest.dynamicTools.map((entry) => {
      const resolve = DYNAMIC_TOOL_SOURCES.get(entry.sourceId);
      if (!resolve) {
        throw new Error(
          `Dynamic tool '${entry.slug}' from ${entry.sourceId} has no resolver registered in capability-budget.ts, so its catalog cost cannot be measured.`
        );
      }
      return resolve(entry, manifest.appRoot, lane);
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
    "skill markdown, appended only when the model loads that skill. eve's own",
    "built-in tools are identical in every lane and are not measured here.",
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
  }
  return lines.join("\n");
}
