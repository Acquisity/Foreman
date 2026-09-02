/**
 * Adapter over eve's own dynamic-tool runtime: it bundles the authored
 * modules the way a deployment does, dispatches a compiled dynamic tool the
 * way eve dispatches it before a model call, and returns only the tools eve
 * admitted.
 *
 * @remarks
 * Everything here is eve's private runtime, reached by path because none of
 * it is on eve's package exports map. That is deliberate: a measurement that
 * reimplemented eve's preparation would report tools the model never sees. A
 * module eve moves or reshapes fails here with the path that broke.
 *
 * This adapter knows nothing about session lanes, budgets, or reporting. It
 * takes the session a resolver should see and gives back the model-visible
 * tools that session carries, so a caller that offers a session nothing
 * measures nothing while a result eve would drop fails outright.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

/** Where `eve info` and `eve build` write the module map the manifest's sources load through. */
const COMPILED_MODULE_MAP_PATH = ".eve/compile/module-map.mjs";

/** eve's own cache for bundled authored modules, which it evaluates from disk. */
const AUTHORED_MODULE_CACHE_PATH = "node_modules/.cache/eve/authored-modules";

const requireFromHere = createRequire(import.meta.url);

/** The eve package this process would run, resolved from node_modules. */
export const evePackageUrl = (): URL =>
  pathToFileURL(requireFromHere.resolve("eve/package.json"));

/** The installed eve's own version, read from its package manifest. */
export const installedEveVersion = (): string =>
  z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(evePackageUrl(), "utf8"))).version;

/**
 * A compiled dynamic tool, in the shape eve's own resolver takes: the module
 * it loads, the export it reads, and the extension namespace it prefixes
 * tool names with.
 */
export const dynamicToolEntrySchema = z.object({
  eventNames: z.array(z.string()).default([]),
  exportName: z.string().optional(),
  extensionNamespace: z.string().optional(),
  logicalPath: z.string(),
  slug: z.string(),
  sourceId: z.string(),
  sourceKind: z.literal("module"),
});

export type DynamicToolEntry = z.infer<typeof dynamicToolEntrySchema>;

/** The session a dynamic tool resolver is dispatched under. */
export interface DynamicToolSession {
  /** The session auth the resolver reads, which is what gates it. */
  readonly auth: SessionAuthContext;
  /** Stable identity for this session: eve's session id, and the cache key. */
  readonly id: string;
}

/** One model-visible tool eve admitted from a dynamic resolver. */
export interface AdmittedDynamicTool {
  readonly description: string;
  readonly name: string;
  readonly schemaChars: number;
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
      `eve no longer exposes what eve-dynamic-tools.ts calls at ${url.href}, so dynamic tools cannot be measured.`,
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
  const file = join(directory, `eve-dynamic-tools-${hash}.mjs`);
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

/** The metadata key eve files a resolver's result under, by event. */
const DYNAMIC_TOOL_METADATA_KEY = {
  "session.started": "SessionDynamicToolMetadataKey",
  "step.started": "StepDynamicToolMetadataKey",
  "turn.started": "TurnDynamicToolMetadataKey",
} as const;

/** A lifecycle event eve resolves dynamic tools on. */
export type DynamicToolEventName = keyof typeof DYNAMIC_TOOL_METADATA_KEY;

/** The same events in the order eve dispatches them within one turn. */
const DYNAMIC_TOOL_EVENTS: readonly DynamicToolEventName[] = [
  "session.started",
  "turn.started",
  "step.started",
];

const isDynamicToolEvent = (name: string): name is DynamicToolEventName =>
  name in DYNAMIC_TOOL_METADATA_KEY;

// The brand `defineTool` stamps, read the way eve reads it, so a single tool
// is told apart from a map of them without counting a tool's own fields.
const TOOL_BRAND = Symbol.for("eve:tool-brand");

const isBrandedTool = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[TOOL_BRAND] === true;

/** How many tool entries a resolver handed eve, before eve judged them. */
const returnedEntryCount = (result: unknown): number => {
  if (result === null || result === undefined) {
    return 0;
  }
  if (isBrandedTool(result)) {
    return 1;
  }
  // Anything else eve reads as a map of entries. A malformed result counts as
  // one, so eve rejecting it still shows up as a shortfall.
  return typeof result === "object" && !Array.isArray(result)
    ? Math.max(1, Object.keys(result).length)
    : 1;
};

/**
 * Wraps a resolver so the number of entries it returned is observable
 * alongside the number eve admitted.
 */
const countingResolver = (
  resolver: DynamicToolResolver,
  returned: { count: number }
): DynamicToolResolver => ({
  ...resolver,
  events: Object.fromEntries(
    Object.entries(resolver.events).map(([name, handler]) => [
      name,
      async (event: unknown, ctx: unknown) => {
        const result = await handler(event, ctx);
        returned.count += returnedEntryCount(result);
        return result;
      },
    ])
  ),
});

/**
 * Admits one dynamic tool resolver's result the way eve does before a model
 * call, and returns only what eve admitted.
 *
 * @remarks
 * A one-resolver {@link openDynamicToolTurn}, dispatched on each event the
 * compiled entry declares, in eve's own lifecycle order. Every rule that
 * matters lives there.
 *
 * @param resolver - The compiled dynamic tool with its handlers attached.
 * @param session - The session whose auth the resolver sees.
 */
export async function admitDynamicTools(
  resolver: DynamicToolResolver,
  session: DynamicToolSession
): Promise<AdmittedDynamicTool[]> {
  for (const eventName of resolver.eventNames) {
    if (!isDynamicToolEvent(eventName)) {
      throw new Error(
        `Dynamic tool '${resolver.slug}' declares unsupported event '${eventName}'.`
      );
    }
  }
  const turn = await openDynamicToolTurn([resolver], session);
  let admitted: AdmittedDynamicTool[] = [];
  for (const eventName of DYNAMIC_TOOL_EVENTS) {
    if (resolver.eventNames.includes(eventName)) {
      // biome-ignore lint/performance/noAwaitInLoops: the dispatches share one context in eve's own lifecycle order, so they have to run in sequence.
      admitted = await turn.dispatch(eventName);
    }
  }
  return admitted;
}

/**
 * One session's dynamic-tool context, held open across lifecycle events.
 *
 * @remarks
 * Order is the reason this exists. eve resolves `turn.started` once, before
 * the turn's first tool runs, and `step.started` again before every model
 * call, then offers the model the session, turn, and step results together
 * (eve's own `buildDynamicTools`). So a capability the turn selects while it
 * runs reaches the model only through a `step.started` resolver, and only a
 * caller that dispatches the events in that order can tell the two apart.
 */
export interface DynamicToolTurn {
  /**
   * Dispatches one lifecycle event against the held context and returns every
   * tool the model would carry after it, read from all three metadata keys the
   * way eve reads them.
   */
  readonly dispatch: (
    eventName: DynamicToolEventName
  ) => Promise<AdmittedDynamicTool[]>;
}

/**
 * Opens one session's dynamic-tool context over a set of resolvers.
 *
 * @remarks
 * This is eve's own dispatch, run against one execution context the caller
 * drives event by event: eve calls each resolver, requires every entry to be a
 * `defineTool`, validates the durable descriptor on each execute, approval,
 * and model-output callback, prefixes an extension's tool names with its
 * namespace, and serializes each input schema the way it is sent to the model.
 *
 * A resolver that returns nothing for this session measures as nothing, which
 * is the point of a gated capability. What must never pass silently is eve
 * dropping entries a resolver did hand it: eve discards a resolver's complete
 * result when any entry is not a `defineTool` or one of its callbacks has no
 * durable descriptor, logging the reason on its `dynamic-tools` logger and
 * nothing else. So the resolvers are counted on the way in as well as on the
 * way out, and a shortfall throws instead of publishing a total for tools the
 * model would never see.
 *
 * The state a resolver reads is a separate matter: eve's `defineState` reads
 * the ambient context, which eve's dispatch does not enter, so a caller that
 * wants a resolver to see session state runs this inside that context.
 *
 * @param resolvers - The compiled dynamic tools with their handlers attached.
 * @param session - The session whose auth the resolvers see.
 */
export async function openDynamicToolTurn(
  resolvers: readonly DynamicToolResolver[],
  session: DynamicToolSession
): Promise<DynamicToolTurn> {
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
          SessionDynamicToolMetadataKey: contextKeySchema,
          SessionIdKey: contextKeySchema,
          StepDynamicToolMetadataKey: contextKeySchema,
          TurnDynamicToolMetadataKey: contextKeySchema,
        })
      ),
      eveRuntimeModule(
        "./dist/src/context/dynamic-tool-lifecycle.js",
        z.object({ dispatchDynamicToolEvent: eveFunction })
      ),
    ]);
  const ctx = new ContextContainer();
  ctx.set(keys.SessionIdKey, session.id);
  ctx.set(keys.AuthKey, session.auth);
  ctx.set(keys.InitiatorAuthKey, session.auth);
  const returned = { count: 0 };
  const counted = resolvers.map((resolver) =>
    countingResolver(resolver, returned)
  );
  const slugs = resolvers.map((resolver) => resolver.slug).join(", ");
  return {
    dispatch: async (eventName: DynamicToolEventName) => {
      // Counted per dispatch, against the key eve files this event's result
      // under: eve replaces that key's entries for the resolvers that ran, so
      // the two numbers describe the same dispatch even when a caller
      // dispatches one event more than once.
      returned.count = 0;
      await dispatchDynamicToolEvent({
        ctx,
        event: { type: eventName },
        messages: [],
        resolvers: counted,
      });
      const forEvent = admittedToolSchema
        .array()
        .parse(ctx.get(keys[DYNAMIC_TOOL_METADATA_KEY[eventName]]) ?? []);
      if (forEvent.length < returned.count) {
        throw new Error(
          `eve admitted ${forEvent.length} of the ${returned.count} tools '${slugs}' resolves on ${eventName}, so the catalog cannot be measured. eve drops a resolver's whole result when an entry is not a defineTool() or one of its callbacks has no durable descriptor; its dynamic-tools log line names the entry.`
        );
      }
      const admitted = DYNAMIC_TOOL_EVENTS.flatMap((name) =>
        admittedToolSchema
          .array()
          .parse(ctx.get(keys[DYNAMIC_TOOL_METADATA_KEY[name]]) ?? [])
      );
      return admitted.map((tool) => ({
        description: tool.description,
        name: tool.name,
        // Serialized by eve without the dialect keyword, as the model sees it.
        schemaChars: JSON.stringify(tool.inputSchema).length,
      }));
    },
  };
}

/**
 * Resolves one compiled dynamic tool the way eve does: the entry is loaded
 * from the bundled module map, so the authored source binds at bundle time
 * (for the GitHub surface that means the mount in
 * `agent/extensions/github/extension.ts` and the lane gate in its
 * `tools/github.ts` override), and eve's dispatch admits what that session
 * carries. An entry whose module is not in the map throws here rather than
 * leaving a tool source uncounted. Nothing leaves the process; a credential is
 * resolved per call at execution time, which this never reaches.
 */
const loadCompiledDynamicToolResolver = async (
  entry: DynamicToolEntry,
  appRoot: string
): Promise<DynamicToolResolver> => {
  const [moduleMap, { resolveDynamicToolDefinition }] = await Promise.all([
    loadAuthoredModuleMap(appRoot),
    eveRuntimeModule(
      "./dist/src/runtime/resolve-dynamic-tool.js",
      z.object({ resolveDynamicToolDefinition: eveFunction })
    ),
  ]);
  return dynamicToolResolverSchema.parse(
    await resolveDynamicToolDefinition(entry, moduleMap, undefined)
  );
};

/**
 * Every compiled dynamic tool of one manifest, with its handlers attached, so
 * a caller can dispatch them together through {@link openDynamicToolTurn}
 * rather than one resolver at a time.
 */
export const loadCompiledDynamicToolResolvers = (
  entries: readonly DynamicToolEntry[],
  appRoot: string
): Promise<DynamicToolResolver[]> =>
  Promise.all(
    entries.map((entry) => loadCompiledDynamicToolResolver(entry, appRoot))
  );

const resolveCompiledDynamicToolsOnce = async (
  entry: DynamicToolEntry,
  appRoot: string,
  session: DynamicToolSession
): Promise<AdmittedDynamicTool[]> =>
  admitDynamicTools(
    await loadCompiledDynamicToolResolver(entry, appRoot),
    session
  );

/**
 * Each resolver runs once per session, compiled entry, and application root.
 * Repeated resolutions of that same session share the result.
 */
const compiledDynamicTools = new Map<string, Promise<AdmittedDynamicTool[]>>();

/** Complete identity of one session's compiled dynamic-tool resolution. */
export const dynamicToolCacheKey = (
  entry: DynamicToolEntry,
  appRoot: string,
  sessionId: string
): string =>
  JSON.stringify([
    appRoot,
    sessionId,
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

export const resolveCompiledDynamicTools = (
  entry: DynamicToolEntry,
  appRoot: string,
  session: DynamicToolSession
): Promise<AdmittedDynamicTool[]> => {
  const key = dynamicToolCacheKey(entry, appRoot, session.id);
  const cached = compiledDynamicTools.get(key);
  if (cached) {
    return cached;
  }
  const loading = resolveCompiledDynamicToolsOnce(entry, appRoot, session);
  compiledDynamicTools.set(key, loading);
  return loading;
};
