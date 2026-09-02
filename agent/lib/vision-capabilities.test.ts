import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";

// capability-budget reaches the root skill graph, which reads both connector
// variables at module load (constants.ts). Nothing is contacted; the values
// only have to exist.
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??=
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

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
  "bash",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
];

// The nested subagent node, which capability-budget's own schema drops: it
// measures the root's surface and needs only each subagent's name.
const TS_EXTENSION = /\.ts$/u;
const NO_GUESSING = /do not guess a path/u;
const NO_URL_OR_PATH = /"no url or path was given"/u;

const visionNodeSchema = z.object({
  subagents: z.array(
    z.object({
      agent: z.object({
        disabledFrameworkTools: z.array(z.string()).default([]),
        tools: z.array(z.object({ name: z.string() })).default([]),
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
    assert.match(instructions, NO_GUESSING);
    assert.match(instructions, NO_URL_OR_PATH);
  });

  it("compiles to read_image and nothing else", {
    skip: !HAS_COMPILED_MANIFEST,
  }, () => {
    const { disabledFrameworkTools, tools } = visionNode();
    assert.deepEqual(
      tools.map(({ name }) => name),
      ["read_image"]
    );
    assert.deepEqual([...disabledFrameworkTools].sort(), DISABLED);
  });
});
