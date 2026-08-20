import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";
import { findIamManagementPoliciesFor } from "./policies.js";

interface Application {
  id: string;
  name: string;
  description: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
  editable: boolean;
  nb_api_keys: number;
  tags?: string[];
}

/** Minimal shape needed to resolve which Application owns THIS server's own operating credential. */
interface OwnApiKey {
  application_id?: string;
}

const createSchema = {
  name: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Application name (max 64 chars, Scaleway API limit). Convention in this org: '<env>-<scope>-<level>' for " +
        "service credentials held by deployed code (e.g. 'dev-payments-files-rw'), 'ops-<name>-<level>' for operator/tool " +
        "identities that administer the account directly (e.g. 'ops-scaleway-mcp-admin'). env ∈ {prod,dev,local,ci,shared}, " +
        "level ∈ {ro,rw,admin,full}. Name must describe the grant that actually exists, not the one intended.",
    ),
  description: z.string().max(200).optional().describe("What this Application is for and why - shown in the console, helps future readers."),
};

const updateSchema = {
  application_id: z.string().uuid(),
  name: z.string().min(1).max(64).optional().describe("New name (max 64 chars) - see scaleway_iam_create_application's description for the naming convention."),
  description: z.string().max(200).optional(),
  tags: z
    .array(z.string())
    .max(10)
    .optional()
    .describe(
      "Structured metadata, max 10. Locked vocabulary in this org: 'env={prod|dev|local|ci|shared}', " +
        "'access={ro|rw|admin|full}', 'owner=<team-or-tool>', 'issue=<n>', 'managed-by={mcp|manual|terraform}'. " +
        "Use '=' as the separator, not ':' - Scaleway's tags API rejects colons " +
        "(validated against ^[a-zA-Z0-9._\\-/=+@ ]+$, confirmed empirically 2026-08-18). " +
        "REPLACES the full tag list (same semantics as scaleway_s3_put_bucket_policy replacing the whole policy " +
        "document) - pass the complete set you want, not just the ones you're adding.",
    ),
};

const listSchema = {
  name_filter: z.string().optional().describe("Case-insensitive substring filter on Application name. Matched against the full list, not just the first page."),
};

const getSchema = {
  application_id: z.string().uuid(),
};

const deleteSchema = {
  application_id: z.string().uuid(),
  confirm: z.literal(true).describe("Must be explicitly true. Deleting an Application also deletes all its API keys and detaches its policies."),
};

export function registerApplications(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_create_application",
    {
      title: "Create Scaleway IAM Application",
      description:
        "Create a new IAM Application (a non-human identity) in this Organization. Creates the identity only - " +
        "it has NO permissions until you attach an IAM Policy (scaleway_iam_create_policy) and/or a Bucket Policy. " +
        "Returns the Application id, needed for both of those next steps.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, description }) =>
      withIamErrorHandling(async () => {
        const app = await iamRequest<Application>(config, "POST", "/applications", {
          name,
          description,
          organization_id: config.SCW_ORGANIZATION_ID,
        });
        return toolJsonResult(app, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_application",
    {
      title: "Update Scaleway IAM Application",
      description:
        "Rename/re-describe/re-tag an existing IAM Application. Only the id is fixed - name, description and tags " +
        "are all safe to change at any time: nothing else in Scaleway references an Application by name (Bucket " +
        "Policies and API keys reference application_id, never the name), so renaming never breaks a live " +
        "credential or requires touching anything downstream. Only the fields you pass are changed; omitted " +
        "fields are left as-is.",
      inputSchema: updateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ application_id, name, description, tags }) =>
      withIamErrorHandling(async () => {
        const app = await iamRequest<Application>(config, "PATCH", `/applications/${application_id}`, {
          name,
          description,
          tags,
        });
        return toolJsonResult(app, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_applications",
    {
      title: "List Scaleway IAM Applications",
      description: "List IAM Applications in this Organization, optionally filtered by name substring.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name_filter }) =>
      withIamErrorHandling(async () => {
        const all = await iamListAll<Application>(config, `/applications?organization_id=${config.SCW_ORGANIZATION_ID}`, "applications");
        let apps = all;
        if (name_filter) {
          const needle = name_filter.toLowerCase();
          apps = apps.filter((a) => a.name.toLowerCase().includes(needle));
        }
        return toolJsonResult({ total_count: all.length, count: apps.length, applications: apps }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_application",
    {
      title: "Get Scaleway IAM Application",
      description: "Get one IAM Application by id, including its API-key count.",
      inputSchema: getSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ application_id }) =>
      withIamErrorHandling(async () => {
        const app = await iamRequest<Application>(config, "GET", `/applications/${application_id}`);
        return toolJsonResult(app, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_application",
    {
      title: "Delete Scaleway IAM Application",
      description:
        "PERMANENTLY delete an IAM Application: also deletes every API key it holds and detaches every policy scoped to it. " +
        "Any credential still deployed somewhere (e.g. in a host's .env.prod) stops authenticating immediately and irreversibly. " +
        "Requires confirm=true. Refused (even with confirm=true) if a policy attached to this Application currently " +
        "grants IAMPolicyManager/IAMApplicationManager: deleting the Application DETACHES that policy rather than " +
        "deleting it, which would silently strip the IAM-management grant from whoever holds it - including this " +
        "server, if this is its own Application - without ever going through scaleway_iam_delete_policy's own guard. " +
        "Also refused outright if this IS the Application that owns THIS server's own operating credential " +
        "(SCW_ACCESS_KEY), independent of the IAM-management check above: deleting it also deletes every API key " +
        "it holds, including the one authenticating this very call, revoking every capability this server has - " +
        "not just IAM - with no way to undo it afterward.",
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ application_id }) =>
      withIamErrorHandling(async () => {
        const ownKey = await iamRequest<OwnApiKey>(config, "GET", `/api-keys/${config.SCW_ACCESS_KEY}`);
        if (ownKey.application_id === application_id) {
          return toolError(
            `Refusing to delete ${application_id}: it is the Application that owns THIS server's own operating ` +
              "credential (SCW_ACCESS_KEY). Deleting an Application deletes every API key it holds, including the " +
              "one authenticating this very call - this server would lose every capability it has, not just IAM " +
              "management, with no way to undo it afterward. This is refused even with confirm=true.",
          );
        }
        const blocking = await findIamManagementPoliciesFor(config, { application_id });
        if (blocking.length > 0) {
          return toolError(
            `Refusing this delete: ${blocking.length} attached polic${blocking.length === 1 ? "y" : "ies"} ` +
              `(${blocking.map((p) => p.name).join(", ")}) currently grant${blocking.length === 1 ? "s" : ""} ` +
              "IAMPolicyManager and/or IAMApplicationManager. Deleting this Application detaches those policies " +
              "(Scaleway does not delete them) rather than revoking them, which would strip that IAM-management " +
              "grant from whoever holds it - including this server, if this is its own Application. This is " +
              "refused even with confirm=true. Move the policy to a different principal first, or change its " +
              "rules with scaleway_iam_set_policy_rules before deleting this Application.",
          );
        }
        await iamRequest<void>(config, "DELETE", `/applications/${application_id}`);
        return toolJsonResult({ deleted: true, application_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
