import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { auditRequest, AuditTrailApiError } from "../auditClient.js";
import { toolJsonResult, toolError } from "../output.js";

interface AuditResource {
  type: string;
  id: string;
  name?: string;
}

interface AuditEvent {
  id: string;
  recorded_at: string | null;
  principal: { id: string };
  organization_id: string;
  project_id?: string | null;
  source_ip: string;
  user_agent?: string | null;
  product_name: string;
  service_name: string;
  method_name: string;
  resources: AuditResource[];
  request_id: string;
  request_body?: unknown;
  status_code: number;
}

interface ListEventsResponse {
  events: AuditEvent[];
  next_page_token?: string | null;
}

async function handleAudit<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuditTrailApiError) return toolError(err.message) as unknown as T;
    throw err;
  }
}

const listSchema = {
  region: z.enum(["fr-par", "nl-ams"]).optional().describe("Defaults to the server's configured region (fr-par)."),
  recorded_after: z.string().optional().describe("ISO 8601 date-time, inclusive. Defaults to 24 hours ago."),
  recorded_before: z.string().optional().describe("ISO 8601 date-time, exclusive. Defaults to now (omitted from the request)."),
  resource_type: z
    .string()
    .optional()
    .describe(
      "Server-side filter on Scaleway's resource_type values (e.g. 'iam_application', 'iam_policy'). The exact " +
        "catalog isn't verified here - omit if unsure and filter the returned events client-side instead.",
    ),
  method_name_contains: z
    .string()
    .optional()
    .describe("Client-side substring filter against method_name, e.g. 'CreateApplication'. Not a real query param on this API - applied after fetching."),
  max_pages: z.number().int().min(1).max(50).optional().describe("Safety cap on pagination (100 events/page). Default 20 (up to 2000 events). This API has no total_count, so completeness can't be confirmed beyond the cap."),
  full_detail: z.boolean().optional().describe("false (default): drop request_id/user_agent/request_body per event to keep the response compact. true: return every field the API provides."),
};

export function registerAuditTrail(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_audit_list_events",
    {
      title: "List Scaleway Audit Trail events",
      description:
        "List Audit Trail events (who did what, when, from where, against what) across this Organization - the " +
        "same data as the console's Audit Trail > Events page. Requires the AuditTrailReadOnly permission set on " +
        "THIS server's own credential; if every call fails with permissions_denied, that's very likely why - grant " +
        "it via scaleway_iam_set_policy_rules (organization scope, same rule as IAMApplicationManager/" +
        "IAMPolicyManager if this server already has those). Defaults to the last 24 hours. Pagination is " +
        "cursor-based with no total_count - max_pages is a safety cap, not a completeness guarantee; the response " +
        "says whether it was truncated and includes the last page token to continue from.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, recorded_after, recorded_before, resource_type, method_name_contains, max_pages, full_detail }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const after = recorded_after ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const cap = max_pages ?? 20;

        const all: AuditEvent[] = [];
        let pageToken: string | undefined;
        let truncated = false;

        for (let page = 0; page < cap; page++) {
          const qp = new URLSearchParams({
            organization_id: config.SCW_ORGANIZATION_ID,
            recorded_after: after,
            order_by: "recorded_at_desc",
            page_size: "100",
          });
          if (recorded_before) qp.set("recorded_before", recorded_before);
          if (resource_type) qp.set("resource_type", resource_type);
          if (pageToken) qp.set("page_token", pageToken);

          const data = await auditRequest<ListEventsResponse>(config, `/regions/${r}/events?${qp.toString()}`);
          all.push(...(data.events ?? []));

          if (!data.next_page_token) {
            pageToken = undefined;
            break;
          }
          pageToken = data.next_page_token;
          if (page === cap - 1) truncated = true;
        }

        let events = all;
        if (method_name_contains) {
          const needle = method_name_contains.toLowerCase();
          events = events.filter((e) => e.method_name.toLowerCase().includes(needle));
        }
        if (!full_detail) {
          events = events.map((e) => ({
            id: e.id,
            recorded_at: e.recorded_at,
            principal: e.principal,
            product_name: e.product_name,
            service_name: e.service_name,
            method_name: e.method_name,
            resources: e.resources,
            status_code: e.status_code,
          })) as AuditEvent[];
        }

        return toolJsonResult(
          { count: events.length, truncated, next_page_token: pageToken ?? null, events },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );
}
