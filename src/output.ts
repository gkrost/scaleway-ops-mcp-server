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

/** Build a successful CallToolResult carrying structured JSON, mirrored as text. */
export function toolJsonResult(data: unknown, maxChars: number): CallToolResult {
  return {
    content: [{ type: "text", text: truncate(JSON.stringify(data, null, 2), maxChars) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/** Build an error CallToolResult. */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
