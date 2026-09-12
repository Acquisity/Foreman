import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { evePackageUrl } from "./eve-dynamic-tools.js";

process.env.EXECUTOR_MCP_CONNECTOR ??= "executor/test";
process.env.LINEAR_CONNECTOR ??= "linear/test";

// Exercise Eve's actual harness and artifact serializer, then inspect the
// actual AI SDK provider call. No authored tool or remote model is executed.
const [{ default: image }, { default: instantly }, harness, serializer] =
  await Promise.all([
    import("../subagents/vision/tools/read_image.js"),
    import("../tools/read_instantly_subworkspace.js"),
    import(
      new URL("./dist/src/harness/tools.js", evePackageUrl()).href
    ) as Promise<{
      buildToolSetFromDefinitions: (input: {
        tools: readonly unknown[];
      }) => ToolSet;
    }>,
    import(
      new URL("./dist/src/tools/schema.js", evePackageUrl()).href
    ) as Promise<{
      serializeInputSchema: (input: unknown) => Record<string, unknown>;
    }>,
  ]);

const definitions = [
  { ...image, name: "read_image" },
  { ...instantly, name: "read_instantly_subworkspace" },
];
const flatSchema = z
  .object({
    $schema: z.string().optional(),
    allOf: z.never().optional(),
    anyOf: z.never().optional(),
    oneOf: z.never().optional(),
    properties: z.record(z.string(), z.looseObject({})),
    required: z.array(z.string()).optional(),
    type: z.literal("object"),
  })
  .passthrough();

describe("provider tool schemas on Eve and AI SDK 7", () => {
  it("sends flat image and Instantly inputs through the real provider boundary", async () => {
    const captured = new Error("Provider schema capture complete");
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        throw captured;
      },
    });
    await assert.rejects(
      generateText({
        maxRetries: 0,
        model,
        prompt: "Inspect the available tools without calling them.",
        tools: harness.buildToolSetFromDefinitions({ tools: definitions }),
      }),
      (error) => error === captured
    );
    assert.equal(model.doGenerateCalls.length, 1);
    const emitted = model.doGenerateCalls[0]?.tools;
    assert.equal(emitted?.length, 2);
    const schemas = new Map<string, z.infer<typeof flatSchema>>();
    for (const definition of definitions) {
      const providerTool = emitted?.find(
        (candidate) =>
          candidate.type === "function" && candidate.name === definition.name
      );
      assert.ok(providerTool?.type === "function");
      const schema = flatSchema.parse(providerTool.inputSchema);
      const { $schema: _dialect, ...canonical } = schema;
      assert.deepEqual(canonical, {
        ...serializer.serializeInputSchema(definition.inputSchema),
        additionalProperties: false,
      });
      schemas.set(definition.name, schema);
    }
    const imageSchema = schemas.get("read_image");
    assert.deepEqual(Object.keys(imageSchema?.properties ?? {}).sort(), [
      "path",
      "url",
    ]);
    assert.equal(imageSchema?.properties.path?.maxLength, 1024);
    assert.equal(imageSchema?.properties.url?.maxLength, 2048);
    const instantlySchema = schemas.get("read_instantly_subworkspace");
    assert.deepEqual(instantlySchema?.properties.resource?.enum, [
      "accounts",
      "campaigns",
      "emails",
    ]);
    assert.deepEqual(instantlySchema?.required, ["resource"]);
    assert.equal(instantlySchema?.properties.limit?.maximum, 100);
    assert.equal(instantlySchema?.properties.limit?.minimum, 1);
    assert.equal(instantlySchema?.properties.startingAfter?.maxLength, 512);
    for (const name of [
      "workspaceId",
      "workspaceName",
      "providerCode",
      "status",
      "campaignId",
      "emailAccount",
      "emailType",
      "latestOfThread",
      "lead",
      "minTimestampCreated",
      "maxTimestampCreated",
    ]) {
      assert.ok(
        instantlySchema?.properties[name],
        `${name} remains model-visible`
      );
    }
  });

  it("retains runtime source and resource filters that JSON Schema cannot express", async () => {
    const workspaceId = "e05cbe7b-67db-4b07-b712-46b9365dc83f";
    // The harness receives the original Standard Schema validator. Flattening
    // its advertised input must not replace the pipe's resource checks.
    const tools = harness.buildToolSetFromDefinitions({ tools: definitions });
    assert.equal(tools.read_image?.inputSchema, image.inputSchema);
    assert.equal(
      tools.read_instantly_subworkspace?.inputSchema,
      instantly.inputSchema
    );
    assert.ok(image.inputSchema instanceof z.ZodType);
    assert.ok(instantly.inputSchema instanceof z.ZodType);
    const imageInput = image.inputSchema["~standard"];
    assert.ok(
      (await imageInput.validate({ url: "https://evil.example/image.png" }))
        .issues
    );
    const validImage = await imageInput.validate({ path: "/tmp/image.png" });
    assert.equal(validImage.issues, undefined);
    const instantlyInput = instantly.inputSchema["~standard"];
    await Promise.all(
      [
        { resource: "accounts", status: 0, workspaceId },
        { providerCode: 1, resource: "campaigns", workspaceId },
        { resource: "emails", status: 1, workspaceId },
        { emailType: "received", resource: "accounts", workspaceId },
        {
          resource: "campaigns",
          workspaceId,
          workspaceName: "duplicate selector",
        },
      ].map(async (input) => {
        assert.ok(
          (await instantlyInput.validate(input)).issues,
          JSON.stringify(input)
        );
      })
    );
    const validCampaign = await instantlyInput.validate({
      resource: "campaigns",
      status: 0,
      workspaceId,
    });
    assert.deepEqual(validCampaign, {
      value: { limit: 20, resource: "campaigns", status: 0, workspaceId },
    });
  });
});
