import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { toolError } from "./output.js";

const IAM_BASE_URL = "https://api.scaleway.com/iam/v1alpha1";

export class IamApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(formatIamErrorBody(status, body));
    this.name = "IamApiError";
  }
}

/**
 * Scaleway's IAM API returns two error shapes worth surfacing specially:
 *  - invalid_arguments: {"details":[{"argument_name":...,"help_message":...,"reason":...}], "message":...}
 *  - permissions_denied: {"details":[{"action":...,"resource":...}], "message":"insufficient permissions"}
 * Both carry the actionable detail in `details`, not `message` alone - surface it.
 */
function formatIamErrorBody(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const message = typeof b.message === "string" ? b.message : `HTTP ${status}`;
    if (Array.isArray(b.details) && b.details.length > 0) {
      const details = b.details
        .map((d) => {
          if (d && typeof d === "object") {
            const dd = d as Record<string, unknown>;
            if (dd.argument_name) return `${dd.argument_name}: ${dd.help_message ?? dd.reason}`;
            if (dd.action || dd.resource) return `action=${dd.action} resource=${dd.resource}`;
          }
          return JSON.stringify(d);
        })
        .join("; ");
      return `Scaleway IAM API error (HTTP ${status}): ${message} — ${details}`;
    }
    return `Scaleway IAM API error (HTTP ${status}): ${message}`;
  }
  return `Scaleway IAM API error (HTTP ${status})`;
}

export async function iamRequest<T>(
  config: Config,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${IAM_BASE_URL}${path}`, {
    method,
    headers: {
      "X-Auth-Token": config.SCW_SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    throw new IamApiError(res.status, parsed);
  }
  return parsed as T;
}

/** Run a tool body, converting IamApiError into a well-formed tool error result. Re-throws anything else. */
export async function withIamErrorHandling(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IamApiError) return toolError(err.message);
    throw err;
  }
}

/**
 * Fetch every page of a paginated IAM list endpoint before returning. Needed because these lists
 * (permission-sets ~174 entries, and any org's applications/policies over time) can exceed one
 * page - filtering client-side against only page 1 silently misses real matches past the cutoff.
 * `pathWithoutPaging` must not already contain `page`/`page_size` query params.
 */
export async function iamListAll<TItem>(
  config: Config,
  pathWithoutPaging: string,
  itemsKey: string,
): Promise<TItem[]> {
  const separator = pathWithoutPaging.includes("?") ? "&" : "?";
  const all: TItem[] = [];
  let page = 1;
  for (;;) {
    const data = await iamRequest<Record<string, unknown>>(
      config,
      "GET",
      `${pathWithoutPaging}${separator}page_size=100&page=${page}`,
    );
    const items = (data[itemsKey] as TItem[] | undefined) ?? [];
    const totalCount = (data.total_count as number | undefined) ?? items.length;
    all.push(...items);
    if (all.length >= totalCount || items.length === 0) break;
    page += 1;
  }
  return all;
}
