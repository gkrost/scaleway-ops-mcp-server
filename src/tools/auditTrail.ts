import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { auditRequest } from "../auditClient.js";
import { toolJsonResult } from "../output.js";
import {
  auditRegionSchema,
  compactApiEvent,
  compactAuthEvent,
  compactCombinedEvent,
  compactSystemEvent,
  cursorPaginate,
  defaultRecordedAfter,
  handleAudit,
  maxPagesSchema,
  recordedAfterSchema,
  recordedBeforeSchema,
  type ApiAuditEvent,
  type AuthAuditEvent,
  type CombinedAuditEvent,
  type SystemAuditEvent,
} from "./auditTrailShared.js";

interface ListEventsResponse {
  events: ApiAuditEvent[];
  next_page_token?: string | null;
}

interface ListAuthenticationEventsResponse {
  events: AuthAuditEvent[];
  next_page_token?: string | null;
}

interface ListSystemEventsResponse {
  events: SystemAuditEvent[];
  next_page_token?: string | null;
}

interface ListCombinedEventsResponse {
  events: CombinedAuditEvent[];
  next_page_token?: string | null;
}

interface EventsOverviewResponse {
  last_events: ApiAuditEvent[];
}

interface ListProductsResponse {
  products: { title: string; name: string; services: { name: string; methods: string[] }[] }[];
  total_count: number;
}

const listSchema = {
  region: auditRegionSchema,
  recorded_after: recordedAfterSchema,
  recorded_before: recordedBeforeSchema,
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
  max_pages: maxPagesSchema.describe("Safety cap on pagination (100 events/page). Default 20 (up to 2000 events). This API has no total_count, so completeness can't be confirmed beyond the cap."),
  full_detail: z.boolean().optional().describe("false (default): drop request_id/user_agent/request_body per event to keep the response compact. true: return every field the API provides."),
};

const authEventsSchema = {
  region: auditRegionSchema,
  recorded_after: recordedAfterSchema,
  recorded_before: recordedBeforeSchema,
  order_by: z.enum(["recorded_at_desc", "recorded_at_asc"]).optional().describe("Default recorded_at_desc (newest first)."),
  max_pages: maxPagesSchema,
  full_detail: z.boolean().optional().describe("false (default): drop user_agent and per-resource detail blobs. true: return every field the API provides."),
};

const systemEventsSchema = {
  region: auditRegionSchema,
  recorded_after: recordedAfterSchema,
  recorded_before: recordedBeforeSchema,
  order_by: z.enum(["recorded_at_desc", "recorded_at_asc"]).optional().describe("Default recorded_at_desc (newest first)."),
  max_pages: maxPagesSchema,
  full_detail: z.boolean().optional().describe("false (default): drop locality/project_id and per-resource detail blobs. true: return every field the API provides."),
};

const combinedEventsSchema = {
  region: auditRegionSchema,
  project_id: z.string().uuid().optional().describe("Filter to one Project. Omit for the whole Organization."),
  resource_type: z.string().optional().describe("Server-side filter on Scaleway's resource_type values - see scaleway_audit_list_products for the catalog."),
  recorded_after: recordedAfterSchema,
  recorded_before: recordedBeforeSchema,
  order_by: z.enum(["recorded_at_desc", "recorded_at_asc"]).optional().describe("Default recorded_at_desc (newest first)."),
  max_pages: maxPagesSchema,
  full_detail: z.boolean().optional().describe("false (default): each event is compacted per its kind (api/auth/system). true: return every field the API provides."),
};

const overviewSchema = {
  region: auditRegionSchema,
  project_id: z.string().uuid().optional().describe("Filter to one Project. Omit for the whole Organization."),
  full_detail: z.boolean().optional().describe("false (default): drop request_id/user_agent/request_body per event. true: return every field the API provides."),
};

const productsSchema = {
  region: auditRegionSchema,
};

const READ_NOTE =
  "Requires the AuditTrailReadOnly permission set on THIS server's own credential; if every call fails with " +
  "permissions_denied, that's very likely why - grant it via scaleway_iam_set_policy_rules (organization scope).";

export function registerAuditTrail(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_audit_list_events",
    {
      title: "List Scaleway Audit Trail events",
      description:
        "List Audit Trail events (who did what, when, from where, against what) across this Organization - the " +
          "same data as the console's Audit Trail > Events page. " +
          READ_NOTE +
          " Defaults to the last 24 hours. Pagination is " +
          "cursor-based with no total_count - max_pages is a safety cap, not a completeness guarantee; the response " +
          "says whether it was truncated and includes the last page token to continue from.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, recorded_after, recorded_before, resource_type, method_name_contains, max_pages, full_detail }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const after = recorded_after ?? defaultRecordedAfter();
        const cap = max_pages ?? 20;

        const { items: events, truncated, nextPageToken } = await cursorPaginate<ApiAuditEvent>(
          async (pageToken) => {
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
            return { items: data.events ?? [], next_page_token: data.next_page_token };
          },
          cap,
        );

        let filtered = events;
        if (method_name_contains) {
          const needle = method_name_contains.toLowerCase();
          filtered = filtered.filter((e) => e.method_name.toLowerCase().includes(needle));
        }
        const out = full_detail ? filtered : filtered.map(compactApiEvent);

        return toolJsonResult(
          { count: out.length, truncated, next_page_token: nextPageToken, events: out },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );

  server.registerTool(
    "scaleway_audit_list_authentication_events",
    {
      title: "List Scaleway Audit Trail authentication events",
      description:
        "List authentication events (logins, API-key/token auth, MFA outcomes - success/failure, origin, " +
          "country, method) across this Organization. A separate endpoint from scaleway_audit_list_events: those " +
          "cover API/resource activity, these cover authentication activity only. " +
          READ_NOTE +
          " Defaults to the last 24 hours. Cursor-based pagination with no total_count, same caveats as " +
          "scaleway_audit_list_events.",
      inputSchema: authEventsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, recorded_after, recorded_before, order_by, max_pages, full_detail }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const after = recorded_after ?? defaultRecordedAfter();
        const cap = max_pages ?? 20;

        const { items: events, truncated, nextPageToken } = await cursorPaginate<AuthAuditEvent>(
          async (pageToken) => {
            const qp = new URLSearchParams({
              organization_id: config.SCW_ORGANIZATION_ID,
              recorded_after: after,
              order_by: order_by ?? "recorded_at_desc",
              page_size: "100",
            });
            if (recorded_before) qp.set("recorded_before", recorded_before);
            if (pageToken) qp.set("page_token", pageToken);
            const data = await auditRequest<ListAuthenticationEventsResponse>(
              config,
              `/regions/${r}/authentication-events?${qp.toString()}`,
            );
            return { items: data.events ?? [], next_page_token: data.next_page_token };
          },
          cap,
        );

        const out = full_detail ? events : events.map(compactAuthEvent);
        return toolJsonResult(
          { count: out.length, truncated, next_page_token: nextPageToken, events: out },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );

  server.registerTool(
    "scaleway_audit_list_system_events",
    {
      title: "List Scaleway Audit Trail system events",
      description:
        "List system events - actions performed by Scaleway's own systems on your resources (product_name / " +
          "system_name / kind), rather than by a user or application. The third event stream besides " +
          "scaleway_audit_list_events (API activity) and scaleway_audit_list_authentication_events " +
          "(authentication). " +
          READ_NOTE +
          " Defaults to the last 24 hours (the API's own default window is 1 hour, so this tool pins it " +
          "explicitly). Cursor-based pagination with no total_count, same caveats as scaleway_audit_list_events.",
      inputSchema: systemEventsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, recorded_after, recorded_before, order_by, max_pages, full_detail }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const after = recorded_after ?? defaultRecordedAfter();
        const cap = max_pages ?? 20;

        const { items: events, truncated, nextPageToken } = await cursorPaginate<SystemAuditEvent>(
          async (pageToken) => {
            const qp = new URLSearchParams({
              organization_id: config.SCW_ORGANIZATION_ID,
              recorded_after: after,
              order_by: order_by ?? "recorded_at_desc",
              page_size: "100",
            });
            if (recorded_before) qp.set("recorded_before", recorded_before);
            if (pageToken) qp.set("page_token", pageToken);
            const data = await auditRequest<ListSystemEventsResponse>(config, `/regions/${r}/system-events?${qp.toString()}`);
            return { items: data.events ?? [], next_page_token: data.next_page_token };
          },
          cap,
        );

        const out = full_detail ? events : events.map(compactSystemEvent);
        return toolJsonResult(
          { count: out.length, truncated, next_page_token: nextPageToken, events: out },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );

  server.registerTool(
    "scaleway_audit_list_combined_events",
    {
      title: "List Scaleway Audit Trail combined events",
      description:
        "List all three Audit Trail event streams in one chronological feed - each event is tagged with its " +
          "kind (api, auth, or system) and compacted per-kind. Use this when investigating a timeline across " +
          "streams; use the per-stream tools (scaleway_audit_list_events, _list_authentication_events, " +
          "_list_system_events) when one stream is enough. " +
          READ_NOTE +
          " Defaults to the last 24 hours. Cursor-based pagination with no total_count, same caveats as " +
          "scaleway_audit_list_events.",
      inputSchema: combinedEventsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, project_id, resource_type, recorded_after, recorded_before, order_by, max_pages, full_detail }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const after = recorded_after ?? defaultRecordedAfter();
        const cap = max_pages ?? 20;

        const { items: events, truncated, nextPageToken } = await cursorPaginate<CombinedAuditEvent>(
          async (pageToken) => {
            const qp = new URLSearchParams({
              organization_id: config.SCW_ORGANIZATION_ID,
              recorded_after: after,
              order_by: order_by ?? "recorded_at_desc",
              page_size: "100",
            });
            if (project_id) qp.set("project_id", project_id);
            if (resource_type) qp.set("resource_type", resource_type);
            if (recorded_before) qp.set("recorded_before", recorded_before);
            if (pageToken) qp.set("page_token", pageToken);
            const data = await auditRequest<ListCombinedEventsResponse>(config, `/regions/${r}/combined-events?${qp.toString()}`);
            return { items: data.events ?? [], next_page_token: data.next_page_token };
          },
          cap,
        );

        const out = full_detail ? events : events.map(compactCombinedEvent);
        return toolJsonResult(
          { count: out.length, truncated, next_page_token: nextPageToken, events: out },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );

  server.registerTool(
    "scaleway_audit_get_last_events_overview",
    {
      title: "Get Scaleway Audit Trail last-events overview",
      description:
        "Get the snapshot of most recent Audit Trail events the console shows on the Audit Trail landing page " +
          "- the last handful of api events, no filters, no pagination. Handy as a cheap 'anything happening " +
          "lately?' check before running a full paginated query. " +
          READ_NOTE,
      inputSchema: overviewSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, project_id, full_detail }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const qp = new URLSearchParams({ organization_id: config.SCW_ORGANIZATION_ID });
        if (project_id) qp.set("project_id", project_id);
        const data = await auditRequest<EventsOverviewResponse>(config, `/regions/${r}/last-events-overview?${qp.toString()}`);
        const events = data.last_events ?? [];
        const out = full_detail ? events : events.map(compactApiEvent);
        return toolJsonResult({ count: out.length, last_events: out }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_list_products",
    {
      title: "List Scaleway products integrated with Audit Trail",
      description:
        "List the products/services integrated with Audit Trail, with their service and method names - the " +
          "catalog behind the resource_type / product_name / service_name / method_name filters of the " +
          "scaleway_audit_list_* event tools. Call this when a filter value is rejected or to discover valid " +
          "values before querying. " +
          READ_NOTE,
      inputSchema: productsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const qp = new URLSearchParams({ organization_id: config.SCW_ORGANIZATION_ID });
        const data = await auditRequest<ListProductsResponse>(config, `/regions/${r}/products?${qp.toString()}`);
        return toolJsonResult(
          { total_count: data.total_count, products: data.products ?? [] },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );
}
