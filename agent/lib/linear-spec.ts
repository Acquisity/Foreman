import { LINEAR_OPERATIONS } from "./linear-operations.js";

export function linearSpec(kind: "query" | "mutation") {
  const mode = kind === "query" ? "read" : "write";
  return {
    components: {
      securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
    },
    info: { title: `Foreman Linear ${mode} API`, version: "1.0.0" },
    openapi: "3.0.3",
    paths: {
      "/graphql": {
        post: {
          operationId:
            kind === "query" ? "executeForemanRead" : "executeForemanWrite",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  additionalProperties: false,
                  properties: {
                    query: {
                      enum: Object.values(LINEAR_OPERATIONS)
                        .filter((op) => op.kind === kind)
                        .map((op) => op.document),
                      type: "string",
                    },
                    variables: { additionalProperties: true, type: "object" },
                  },
                  required: ["query", "variables"],
                  type: "object",
                },
              },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { additionalProperties: true, type: "object" },
                },
              },
              description: "Linear GraphQL response",
            },
          },
          summary: `Only exact authored Foreman ${mode} operations. No arbitrary GraphQL.`,
        },
      },
    },
    security: [{ bearer: [] }],
    servers: [{ url: "https://api.linear.app" }],
  };
}
