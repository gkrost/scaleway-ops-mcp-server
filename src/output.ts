import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Truncate text to maxChars, appending a notice if truncated. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.length - maxChars;
  return text.slice(0, maxChars) + `\n[... truncated ${truncated} chars]`;
}

/** Build a successful CallToolResult from pre-formatted text. */
export function toolResult(text: string, maxChars: number): CallToolResult {
  return {
    content: [{ type: "text", text: truncate(text, maxChars) }],
  };
}

/** Build a successful CallToolResult carrying structured JSON, mirrored as text.
 * When the untruncated JSON exceeds maxChars, structuredContent carries a truncation
 * marker instead of the real data - never the field silently missing - so a caller
 * that reads structuredContent (rather than parsing the text mirror) gets an explicit,
 * typed signal that it was cut, instead of something indistinguishable from "no
 * structured content for this tool". */
export function toolJsonResult(data: unknown, maxChars: number): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  const truncated = text.length > maxChars;
  return {
    content: [{ type: "text", text: truncate(text, maxChars) }],
    structuredContent: truncated
      ? {
          truncated: true,
          note: `Response exceeds MAX_OUTPUT_CHARS (${maxChars} chars) - structuredContent omitted; see the truncated JSON in the text content instead.`,
        }
      : (data as Record<string, unknown>),
  };
}

/** Build an error CallToolResult. */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
