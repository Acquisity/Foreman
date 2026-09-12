import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";

// capability-budget reaches the root skill graph, which reads both connector
// variables at module load (constants.ts). Nothing is contacted; the values
// only have to exist.
process.env.LINEAR_CONNECTOR ??= "linear/test";

const { COMPILE_METADATA_PATH, COMPILED_MANIFEST_PATH, readCompiledManifest } =
  await import("./capability-budget.js");

const APP_ROOT = new URL("../../", import.meta.url);
const VISION_ROOT = new URL("../subagents/vision/", import.meta.url);

// `pnpm validate` runs `eve info` before the tests, so the manifest describes
// this tree. A bare `pnpm test` may have none; the source assertions below
// still run.
const HAS_COMPILED_MANIFEST = [
  COMPILED_MANIFEST_PATH,
  COMPILE_METADATA_PATH,
].every((path) => existsSync(new URL(path, APP_ROOT)));

/**
 * eve defaults the vision child would otherwise carry. Told to read an image
 * it was never given, a child with these crawled the shared sandbox for 106
 * steps and 46 out-of-memory kills before failing.
 */
const DISABLED = [
  "ask_question",
  "bash",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
];

// The nested subagent node, which capability-budget's own schema drops: it
// measures the root's delegation tools, not the child's own capability surface.
const TS_EXTENSION = /\.ts$/u;
// The whole conditional, trigger included: a malformed or non-Linear url is
// not "no url or path at all", so it must reach read_image and surface
// read_image's own error instead of this answer.
const NO_IMAGE_REFUSAL =
  /If the parent gave you no url or path at all, do not guess a path: answer that the image could not be read, leave `visible_text` empty, and put "no url or path was given" in `uncertainties`\./u;

const visionNodeSchema = z.object({
  subagents: z.array(
    z.object({
      agent: z.object({
        connections: z.array(z.unknown()),
        dynamicTools: z.array(
          z.object({ slug: z.string(), sourceId: z.string() })
        ),
        sourceComposition: z.object({
          entries: z.array(
            z.object({
              kind: z.string(),
              source: z.object({ sourceId: z.string() }),
            })
          ),
        }),
        tools: z.array(z.object({ name: z.string(), sourceId: z.string() })),
      }),
      name: z.string(),
    })
  ),
});

const visionNode = () => {
  // Provenance first: a half-written compile, or one from another eve, would
  // describe a surface this tree does not have.
  readCompiledManifest(APP_ROOT);
  const parsed = visionNodeSchema.parse(
    JSON.parse(readFileSync(new URL(COMPILED_MANIFEST_PATH, APP_ROOT), "utf8"))
  );
  const vision = parsed.subagents.find(({ name }) => name === "vision");
  assert.ok(vision, "the compiled manifest has no vision subagent");
  return vision.agent;
};

describe("vision capability surface", () => {
  it("authors a sentinel for every default tool it disables", () => {
    const sentinels = readdirSync(new URL("tools/", VISION_ROOT))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        readFileSync(new URL(`tools/${file}`, VISION_ROOT), "utf8").includes(
          "disableTool()"
        )
      )
      .map((file) => file.replace(TS_EXTENSION, ""))
      .sort();
    assert.deepEqual(sentinels, DISABLED);
  });

  it("refuses to guess a path when the parent named no image", () => {
    const instructions = readFileSync(
      new URL("instructions.md", VISION_ROOT),
      "utf8"
    );
    assert.match(instructions, NO_IMAGE_REFUSAL);
  });

  it("compiles only the image tool and retained framework defaults", {
    skip: HAS_COMPILED_MANIFEST
      ? false
      : "run pnpm validate to compile the repository manifest first",
  }, () => {
    const { connections, dynamicTools, sourceComposition, tools } =
      visionNode();
    assert.deepEqual(tools, [
      { name: "load_skill", sourceId: "eve:defaults:tools/load_skill.ts" },
      { name: "task_cancel", sourceId: "eve:defaults:tools/task_cancel.ts" },
      { name: "read_image", sourceId: "tools/read_image.ts" },
    ]);
    assert.deepEqual(dynamicTools, [
      {
        slug: "connection_search",
        sourceId: "eve:defaults:tools/connection_search.ts",
      },
    ]);
    assert.deepEqual(connections, []);
    assert.deepEqual(
      sourceComposition.entries
        .filter((entry) => entry.kind === "disabled")
        .map((entry) => entry.source.sourceId)
        .sort(),
      DISABLED.map((name) => `tools/${name}.ts`)
    );
  });
});
