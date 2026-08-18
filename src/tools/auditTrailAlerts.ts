import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { auditRequest } from "../auditClient.js";
import { toolJsonResult } from "../output.js";
import {
  auditRegionSchema,
  confirmSchema,
  handleAudit,
  maxPagesSchema,
  numberPaginate,
  WRITE_PERMISSIONS_NOTE,
} from "./auditTrailShared.js";

interface AlertRule {
  id: string;
  name: string;
  description?: string | null;
  status: string;
}

interface CustomAlertRule {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  query: string;
  evaluation_window?: string | null;
  occurrences: number;
  severity?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface ListAlertRulesResponse {
  alert_rules: AlertRule[];
  total_count: number;
}

interface ListCustomAlertRulesResponse {
  custom_alert_rules: CustomAlertRule[];
  total_count: number;
}

interface MutateAlertRulesResponse {
  alert_rules: AlertRule[];
}

interface MutateCustomAlertRulesResponse {
  custom_alert_rules: CustomAlertRule[];
}

const statusFilterSchema = z
  .enum(["enabled", "disabled", "enabling", "disabling"])
  .optional()
  .describe("Filter by current status. Omit to list all rules regardless of status.");

const alertRulesCommon = {
  region: auditRegionSchema,
  status: statusFilterSchema,
  max_pages: maxPagesSchema,
};

const setEnabledSchema = {
  region: auditRegionSchema,
  rule_ids: z.array(z.string().uuid()).min(1).describe("IDs of the preconfigured rules to enable or disable - from scaleway_audit_list_alert_rules."),
  enabled: z.boolean().describe("true: enable exactly these rules (others untouched). false: disable exactly these rules (others untouched)."),
};

const replaceEnabledSchema = {
  region: auditRegionSchema,
  enabled_alert_rule_ids: z
    .array(z.string().uuid())
    .describe("The COMPLETE set of rule IDs that should be enabled afterwards. Every currently-enabled rule NOT in this list gets disabled. An empty array disables ALL alert rules."),
  confirm: confirmSchema.describe("Must be explicitly true. This is a full-replace: rules omitted from the list are silently disabled."),
};

const customListSchema = {
  region: auditRegionSchema,
  status: statusFilterSchema,
  max_pages: maxPagesSchema,
};

const customCreateSchema = {
  region: auditRegionSchema,
  name: z.string().min(1).describe("Name of the custom alert rule."),
  description: z.string().optional().describe("What this rule alerts on and why it exists."),
  query: z
    .string()
    .min(1)
    .describe(
      "CEL (Common Expression Language) expression defining the match, evaluated against incoming audit events. " +
        "Scaleway does not document the full field surface here - an invalid expression is rejected by the API with " +
        "the reason in the error message.",
    ),
  evaluation_window: z
    .string()
    .optional()
    .describe('How far back to look for matching events, as a duration string, e.g. "300s". Omit for the API default.'),
  occurrences: z
    .number()
    .int()
    .min(1)
    .describe("Minimum number of matching events within the evaluation window required to trigger the alert."),
  severity: z.enum(["info", "error", "warning", "critical"]).optional().describe("Severity assigned to the alert. Default info."),
};

const customUpdateSchema = {
  region: auditRegionSchema,
  custom_alert_rule_id: z.string().uuid().describe("ID of the custom alert rule to update - from scaleway_audit_list_custom_alert_rules."),
  name: z.string().min(1).optional().describe("New name. Omit to leave unchanged."),
  description: z.string().optional().describe("New description. Omit to leave unchanged."),
};

const customDeleteSchema = {
  region: auditRegionSchema,
  custom_alert_rule_id: z.string().uuid().describe("ID of the custom alert rule to delete - from scaleway_audit_list_custom_alert_rules."),
  confirm: confirmSchema.describe("Must be explicitly true. Deletion is immediate and irreversible."),
};

const customSetEnabledSchema = {
  region: auditRegionSchema,
  rule_ids: z.array(z.string().uuid()).min(1).describe("IDs of the custom rules to enable or disable - from scaleway_audit_list_custom_alert_rules."),
  enabled: z.boolean().describe("true: enable exactly these rules (others untouched). false: disable exactly these rules (others untouched)."),
};

const customReplaceEnabledSchema = {
  region: auditRegionSchema,
  enabled_custom_alert_rule_ids: z
    .array(z.string().uuid())
    .describe("The COMPLETE set of custom rule IDs that should be enabled afterwards. Every currently-enabled custom rule NOT in this list gets disabled. An empty array disables ALL custom alert rules."),
  confirm: confirmSchema.describe("Must be explicitly true. This is a full-replace: rules omitted from the list are silently disabled."),
};

const customRulesNote =
  "CAVEAT (live-verified 2026-08-18): Scaleway documents the custom-alert-rules endpoints, but the deployed API " +
  "(fr-par) returns HTTP 501 'unknown method' for every custom-alert-rules method - this tool is kept for when " +
  "Scaleway implements them and currently surfaces that error verbatim. Don't retry on 501; the preconfigured " +
  "rules via scaleway_audit_list_alert_rules are the working alternative today.";

const atomicRejectNote =
  "Live-verified 2026-08-18: an unknown rule ID rejects the whole request (HTTP 404) - no partial application.";

export function registerAuditTrailAlerts(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_audit_list_alert_rules",
    {
      title: "List Scaleway Audit Trail alert rules",
      description:
        "List Scaleway's preconfigured Audit Trail alert rules for this Organization and their current status " +
          "(enabled/disabled) - the console's Audit Trail > Alerts page. These rules are defined by Scaleway and " +
          "cannot be created or deleted, only enabled/disabled. " +
          WRITE_PERMISSIONS_NOTE,
      inputSchema: alertRulesCommon,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, status, max_pages }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const { items, total_count, truncated } = await numberPaginate<AlertRule>(
          async (page) => {
            const qp = new URLSearchParams({
              organization_id: config.SCW_ORGANIZATION_ID,
              page: String(page),
              page_size: "100",
            });
            if (status) qp.set("status", status);
            const data = await auditRequest<ListAlertRulesResponse>(config, `/regions/${r}/alert-rules?${qp.toString()}`);
            return { items: data.alert_rules ?? [], total_count: data.total_count ?? 0 };
          },
          max_pages ?? 20,
        );
        return toolJsonResult({ total_count, count: items.length, truncated, alert_rules: items }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_set_alert_rules_enabled",
    {
      title: "Enable or disable Scaleway Audit Trail alert rules",
      description:
        "Enable or disable specific preconfigured Audit Trail alert rules by ID. Touches ONLY the listed rules - " +
          "the enabled/disabled state of every other rule is left unchanged (unlike " +
          "scaleway_audit_replace_enabled_alert_rules, which rewrites the whole enabled set). " +
          "Get IDs from scaleway_audit_list_alert_rules. " +
          atomicRejectNote +
          " " +
          WRITE_PERMISSIONS_NOTE,
      inputSchema: setEnabledSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, rule_ids, enabled }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const action = enabled ? "enable-alert-rules" : "disable-alert-rules";
        const data = await auditRequest<MutateAlertRulesResponse>(config, `/regions/${r}/${action}`, {
          method: "POST",
          body: { organization_id: config.SCW_ORGANIZATION_ID, alert_rule_ids: rule_ids },
        });
        return toolJsonResult({ enabled, affected: data.alert_rules ?? [] }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_replace_enabled_alert_rules",
    {
      title: "Replace the enabled set of Scaleway Audit Trail alert rules",
      description:
        "Atomically replace the COMPLETE set of enabled preconfigured alert rules: after this call, exactly the " +
          "listed rules are enabled and every other preconfigured rule is disabled - including ones you did not " +
          "mention. Prefer scaleway_audit_set_alert_rules_enabled (additive) unless you genuinely want " +
          "full-replace semantics, e.g. syncing to a declared state. " +
          atomicRejectNote +
          " Requires confirm=true. " +
          WRITE_PERMISSIONS_NOTE,
      inputSchema: replaceEnabledSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, enabled_alert_rule_ids }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const data = await auditRequest<MutateAlertRulesResponse>(config, `/regions/${r}/alert-rules`, {
          method: "PATCH",
          body: { organization_id: config.SCW_ORGANIZATION_ID, enabled_alert_rule_ids },
        });
        return toolJsonResult({ now_enabled: data.alert_rules ?? [] }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_list_custom_alert_rules",
    {
      title: "List Scaleway Audit Trail custom alert rules",
      description:
        "List this Organization's custom Audit Trail alert rules (CEL-expression alerts you created) with their " +
          "query, evaluation window, occurrence threshold, severity, and enabled/disabled status. Distinct from " +
          "scaleway_audit_list_alert_rules, which lists Scaleway's preconfigured rules. " +
          WRITE_PERMISSIONS_NOTE +
          " " +
          customRulesNote,
      inputSchema: customListSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, status, max_pages }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const { items, total_count, truncated } = await numberPaginate<CustomAlertRule>(
          async (page) => {
            const qp = new URLSearchParams({
              organization_id: config.SCW_ORGANIZATION_ID,
              page: String(page),
              page_size: "100",
            });
            if (status) qp.set("status", status);
            const data = await auditRequest<ListCustomAlertRulesResponse>(config, `/regions/${r}/custom-alert-rules?${qp.toString()}`);
            return { items: data.custom_alert_rules ?? [], total_count: data.total_count ?? 0 };
          },
          max_pages ?? 20,
        );
        return toolJsonResult(
          { total_count, count: items.length, truncated, custom_alert_rules: items },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );

  server.registerTool(
    "scaleway_audit_create_custom_alert_rule",
    {
      title: "Create a Scaleway Audit Trail custom alert rule",
      description:
        "Create a custom Audit Trail alert rule: a CEL expression evaluated against incoming audit events, " +
          "firing when at least `occurrences` matching events land within `evaluation_window`. " +
          "Metadata-only edits later via scaleway_audit_update_custom_alert_rule; the query itself cannot be " +
          "changed in place - to change the logic, create a new rule and delete the old one. " +
          WRITE_PERMISSIONS_NOTE +
          " " +
          customRulesNote,
      inputSchema: customCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ region, name, description, query, evaluation_window, occurrences, severity }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const rule = await auditRequest<CustomAlertRule>(config, `/regions/${r}/custom-alert-rules`, {
          method: "POST",
          body: {
            organization_id: config.SCW_ORGANIZATION_ID,
            name,
            description,
            query,
            evaluation_window,
            occurrences,
            severity,
          },
        });
        return toolJsonResult(rule, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_update_custom_alert_rule",
    {
      title: "Update a Scaleway Audit Trail custom alert rule",
      description:
        "Update a custom alert rule's metadata (name/description) in place. The API exposes ONLY these two " +
          "fields on update - the query, evaluation window, occurrences, and severity are immutable after " +
          "creation; changing the logic means create-new + delete-old. " +
          WRITE_PERMISSIONS_NOTE +
          " " +
          customRulesNote,
      inputSchema: customUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, custom_alert_rule_id, name, description }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const rule = await auditRequest<CustomAlertRule>(config, `/regions/${r}/custom-alert-rules/${custom_alert_rule_id}`, {
          method: "PATCH",
          body: { name, description },
        });
        return toolJsonResult(rule, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_delete_custom_alert_rule",
    {
      title: "Delete a Scaleway Audit Trail custom alert rule",
      description:
        "PERMANENTLY delete a custom alert rule by ID. Requires confirm=true. Irreversible - the rule's " +
          "definition is gone, though past events it recorded remain in the event streams. " +
          WRITE_PERMISSIONS_NOTE +
          " " +
          customRulesNote,
      inputSchema: customDeleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ region, custom_alert_rule_id }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        await auditRequest<void>(config, `/regions/${r}/custom-alert-rules/${custom_alert_rule_id}`, {
          method: "DELETE",
        });
        return toolJsonResult({ deleted: true, custom_alert_rule_id }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_set_custom_alert_rules_enabled",
    {
      title: "Enable or disable Scaleway Audit Trail custom alert rules",
      description:
        "Enable or disable specific custom alert rules by ID. Touches ONLY the listed rules - the state of " +
          "every other custom rule is left unchanged (unlike scaleway_audit_replace_enabled_custom_alert_rules, " +
          "which rewrites the whole enabled set). Get IDs from scaleway_audit_list_custom_alert_rules. " +
          WRITE_PERMISSIONS_NOTE +
          " " +
          customRulesNote,
      inputSchema: customSetEnabledSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, rule_ids, enabled }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const action = enabled ? "enable-custom-alert-rules" : "disable-custom-alert-rules";
        const data = await auditRequest<MutateCustomAlertRulesResponse>(config, `/regions/${r}/${action}`, {
          method: "POST",
          body: { organization_id: config.SCW_ORGANIZATION_ID, custom_alert_rule_ids: rule_ids },
        });
        return toolJsonResult({ enabled, affected: data.custom_alert_rules ?? [] }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_replace_enabled_custom_alert_rules",
    {
      title: "Replace the enabled set of Scaleway Audit Trail custom alert rules",
      description:
        "Atomically replace the COMPLETE set of enabled custom alert rules: after this call, exactly the listed " +
          "custom rules are enabled and every other custom rule is disabled - including ones you did not " +
          "mention. Prefer scaleway_audit_set_custom_alert_rules_enabled (additive) unless you genuinely want " +
          "full-replace semantics. Requires confirm=true. " +
          WRITE_PERMISSIONS_NOTE +
          " " +
          customRulesNote,
      inputSchema: customReplaceEnabledSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, enabled_custom_alert_rule_ids }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const data = await auditRequest<MutateCustomAlertRulesResponse>(config, `/regions/${r}/custom-alert-rules`, {
          method: "PUT",
          body: { organization_id: config.SCW_ORGANIZATION_ID, enabled_custom_alert_rule_ids },
        });
        return toolJsonResult({ now_enabled: data.custom_alert_rules ?? [] }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
