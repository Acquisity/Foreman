import { defineTool } from "eve/tools";
import { z } from "zod";

const AXIOM_QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=legacy";

/** Hard caps keeping log evidence bounded for the model's context. */
const MAX_MATCHES = 100;
const MAX_RESULT_CHARS = 60_000;

/**
 * Read-only production log search against Axiom.
 *
 * @remarks
 * Token-backed authored tool: the Axiom API token stays in the trusted
 * runtime (`AXIOM_TOKEN`, an encrypted Vercel environment variable) and
 * never reaches the model or a sandbox. The APL query endpoint is
 * read-only by construction — it cannot mutate datasets. Results are
 * bounded to {@link MAX_MATCHES} matches and {@link MAX_RESULT_CHARS}
 * characters.
 */
export default defineTool({
  description:
    "Search production logs in Axiom with an APL query (e.g. \"['vercel'] | where level == 'error' | limit 50\"). " +
    "Read-only. Use it while investigating bug tickets to find errors, request context, and timing evidence. " +
    "Provide ISO-8601 startTime/endTime to bound the window; results are truncated to keep responses small.",
  async execute({ apl, startTime, endTime }) {
    const token = process.env.AXIOM_TOKEN;
    if (!token) {
      return {
        error:
          "AXIOM_TOKEN is not configured; log search is unavailable on this deployment.",
        results: "",
        truncated: false,
      };
    }
    try {
      const response = await fetch(AXIOM_QUERY_URL, {
        body: JSON.stringify({ apl, endTime, startTime }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        return {
          error: `Axiom query failed (${response.status}): ${detail}`,
          results: "",
          truncated: false,
        };
      }
      const data = (await response.json()) as {
        matches?: unknown[];
        buckets?: unknown;
        status?: unknown;
      };
      const matches = data.matches ?? [];
      const bounded = matches.slice(0, MAX_MATCHES);
      let results = JSON.stringify(
        { matches: bounded, status: data.status },
        null,
        1
      );
      let truncated = matches.length > bounded.length;
      if (results.length > MAX_RESULT_CHARS) {
        results = results.slice(0, MAX_RESULT_CHARS);
        truncated = true;
      }
      return { results, truncated };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Axiom query failed.",
        results: "",
        truncated: false,
      };
    }
  },
  inputSchema: z.object({
    apl: z
      .string()
      .min(1)
      .describe(
        "APL query, including the dataset (e.g. \"['dataset'] | where ... | limit 50\")"
      ),
    endTime: z.string().optional().describe("ISO-8601 end of the query window"),
    startTime: z
      .string()
      .optional()
      .describe("ISO-8601 start of the query window"),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    results: z.string(),
    truncated: z.boolean(),
  }),
});
