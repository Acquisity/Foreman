/**
 * An MCP tool result's payload as text. v2 apps often return their data only
 * in `structuredContent` with `content: []`, so structured data wins, as JSON;
 * otherwise the text parts are joined. Undefined when the result has neither.
 */
export function mcpResultText(
  data: unknown,
  separator = "\n"
): string | undefined {
  const result = data as {
    content?: unknown;
    structuredContent?: unknown;
  } | null;
  if (
    result?.structuredContent !== undefined &&
    result.structuredContent !== null
  ) {
    return JSON.stringify(result.structuredContent);
  }
  if (!Array.isArray(result?.content)) {
    return undefined;
  }
  return result.content
    .flatMap((part: { text?: unknown; type?: unknown } | null) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : []
    )
    .join(separator);
}
