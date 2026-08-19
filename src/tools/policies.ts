import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";

interface Rule {
  id: string;
  permission_set_names: string[];
  project_ids?: string[];
  organization_id?: string;
}

interface Policy {
  id: string;
  name: string;
  description: string;
  organization_id: string;
  application_id?: string;
  user_id?: string;
  group_id?: string;
  created_at: string;
  updated_at: string;
  editable: boolean;
  /** NOT populated by GET/list responses despite being part of create's request body - confirmed empirically
   *  2026-08-12. Rules live at the separate /policies/{id}/rules endpoint - see list_policy_rules below. */
  rules?: Rule[];
  tags?: string[];
}

const ruleSchema = z
  .object({
    permission_set_names: z
      .array(z.string())
      .min(1)
      .describe("Permission set names, e.g. ['ObjectStorageReadOnly']. ALL names in one rule must share the same scope_type - call scaleway_iam_list_permission_sets first to check."),
    project_ids: z
      .array(z.string().uuid())
      .optional()
      .describe("Project-scoped rule: use for permission sets with scope_type='projects' (most product permission sets, e.g. ObjectStorageFullAccess)."),
    organization_id: z
      .string()
      .uuid()
      .optional()
      .describe("Organization-scoped rule: use for permission sets with scope_type='organization' (e.g. IAMPolicyManager, IAMApplicationManager). Mutually exclusive with project_ids."),
  })
  .describe("Exactly one of project_ids/organization_id should be set, matching the scope_type of this rule's permission sets.");

const createSchema = {
  name: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Policy name (max 64 chars, Scaleway API limit). Convention in this org: match the principal Application's " +
        "own name 1:1 (e.g. Application 'dev-payments-files-rw' -> Policy 'dev-payments-files-rw'). When one Application " +
        "genuinely needs two policies (Scaleway's rule scope_type restriction - see scaleway_iam_list_permission_sets), " +
        "suffix the second with what it specifically adds, not a restatement of the app name.",
    ),
  description: z.string().max(200).optional(),
  application_id: z.string().uuid().optional().describe("Attach this policy to an Application. Omit application_id/user_id/group_id to create a policy with no principal yet."),
  user_id: z.string().uuid().optional(),
  group_id: z.string().uuid().optional(),
  rules: z
    .array(ruleSchema)
    .min(1)
    .describe("One rule per scope_type needed. E.g. one rule with organization_id + ['IAMPolicyManager'], a second with project_ids + ['ObjectStorageFullAccess']."),
};

const updateSchema = {
  policy_id: z.string().uuid(),
  name: z.string().min(1).max(64).optional().describe("New name (max 64 chars) - see scaleway_iam_create_policy's description for the naming convention."),
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
        "REPLACES the full tag list - pass the complete set you want, not just the ones you're adding. Does NOT " +
        "touch rules, application_id, or any other principal/permission field.",
    ),
};

const cloneSchema = {
  policy_id: z.string().uuid(),
};

const listSchema = {
  application_id: z.string().uuid().optional().describe("Filter to policies attached to one Application."),
};

const getSchema = {
  policy_id: z.string().uuid(),
};

const rulesIdSchema = {
  policy_id: z.string().uuid(),
};

const setRulesSchema = {
  policy_id: z.string().uuid(),
  rules: z
    .array(ruleSchema)
    .min(1)
    .describe(
      "The COMPLETE rules array to set - this REPLACES every existing rule on the policy, it does not merge or " +
        "append. Call scaleway_iam_list_policy_rules first, add/remove/edit within that array, then pass the " +
        "whole thing back here. This is the safe way to change a live policy's grants: unlike delete+recreate, " +
        "there's no window where the policy (or the permissions it grants its own holder) doesn't exist.",
    ),
  confirm: z
    .literal(true)
    .describe(
      "Must be explicitly true. This is a full-replace of live grants: omitting the rule that grants this " +
        "server IAMPolicyManager/IAMApplicationManager permanently locks the credential out of IAM.",
    ),
};

const deleteSchema = {
  policy_id: z.string().uuid(),
  confirm: z.literal(true).describe("Must be explicitly true. Deleting a policy immediately revokes every permission it granted."),
};

export function registerPolicies(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_create_policy",
    {
      title: "Create Scaleway IAM Policy",
      description:
        "Create an IAM Policy granting permission sets to an Application/User/Group, scoped to specific Project(s) or " +
        "the whole Organization. This is the PROJECT-WIDE half of access control - for Object Storage specifically, it " +
        "grants access to every bucket in the Project(s); narrow to one bucket with a Bucket Policy " +
        "(scaleway_s3_put_bucket_policy) as well. A Bucket Policy alone is NOT sufficient on Scaleway - both are " +
        "required together for an Application to actually read/write a specific bucket. " +
        "Call scaleway_iam_list_permission_sets first to get exact names and scope_types.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, description, application_id, user_id, group_id, rules }) =>
      withIamErrorHandling(async () => {
        const policy = await iamRequest<Policy>(config, "POST", "/policies", {
          name,
          description,
          organization_id: config.SCW_ORGANIZATION_ID,
          application_id,
          user_id,
          group_id,
          rules,
        });
        return toolJsonResult(policy, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_clone_policy",
    {
      title: "Clone Scaleway IAM Policy",
      description:
        "Clone an existing IAM Policy. The result is an exact copy: same rules, same principal " +
        "(application_id/user_id/group_id), same tags. Name gets Scaleway's own 'Copy of <name>' default - rename " +
        "afterward with scaleway_iam_update_policy if a distinct name is needed (nothing references a Policy by " +
        "name, so renaming is always safe). Gotcha this tool works around: Scaleway's underlying CLONE endpoint " +
        "(POST /policies/{id}/clone) ignores its request body entirely and always returns the clone UNATTACHED " +
        "(no_principal, tags stripped) regardless of the source - confirmed empirically 2026-08-18. This tool " +
        "follows up with a PATCH restoring the source's principal and tags before returning, so the clone you get " +
        "back actually matches what 'clone' implies, instead of a silently orphaned policy with no built-in way " +
        "to reattach it. As with scaleway_iam_create_policy, the response's nb_rules/nb_permission_sets counts can " +
        "read 0 immediately after this call despite rules having copied correctly - call " +
        "scaleway_iam_list_policy_rules for ground truth if that count looks wrong.",
      inputSchema: cloneSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ policy_id }) =>
      withIamErrorHandling(async () => {
        const source = await iamRequest<Policy>(config, "GET", `/policies/${policy_id}`);
        const clone = await iamRequest<Policy>(config, "POST", `/policies/${policy_id}/clone`, {});
        const patched = await iamRequest<Policy>(config, "PATCH", `/policies/${clone.id}`, {
          application_id: source.application_id,
          user_id: source.user_id,
          group_id: source.group_id,
          tags: source.tags,
        });
        return toolJsonResult(patched, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_policy",
    {
      title: "Update Scaleway IAM Policy",
      description:
        "Rename/re-describe/re-tag an existing IAM Policy. Does NOT touch rules, application_id, or any other " +
        "principal/permission field - only name, description, tags change, so this never alters what the policy " +
        "grants or to whom. Nothing references a Policy by name, so renaming is always safe. Only the fields you " +
        "pass are changed; omitted fields are left as-is.",
      inputSchema: updateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ policy_id, name, description, tags }) =>
      withIamErrorHandling(async () => {
        const policy = await iamRequest<Policy>(config, "PATCH", `/policies/${policy_id}`, {
          name,
          description,
          tags,
        });
        return toolJsonResult(policy, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_policies",
    {
      title: "List Scaleway IAM Policies",
      description: "List IAM Policies in this Organization, optionally filtered to those attached to one Application.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ application_id }) =>
      withIamErrorHandling(async () => {
        // Confirmed empirically (2026-08-12): this endpoint's application_id query param is silently
        // ignored server-side - it returns every policy in the org regardless. Filter client-side.
        const all = await iamListAll<Policy>(config, `/policies?organization_id=${config.SCW_ORGANIZATION_ID}`, "policies");
        const policies = application_id ? all.filter((p) => p.application_id === application_id) : all;
        return toolJsonResult({ total_count: all.length, count: policies.length, policies }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_policy",
    {
      title: "Get Scaleway IAM Policy",
      description:
        "Get one IAM Policy's metadata (name, description, tags, application_id, nb_rules count) by id. Does NOT " +
        "return the actual rules array - confirmed empirically that Scaleway's GET here never populates it despite " +
        "create accepting rules in its request body. Call scaleway_iam_list_policy_rules for the real rules.",
      inputSchema: getSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ policy_id }) =>
      withIamErrorHandling(async () => {
        const policy = await iamRequest<Policy>(config, "GET", `/policies/${policy_id}`);
        return toolJsonResult(policy, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_policy_rules",
    {
      title: "List rules on a Scaleway IAM Policy",
      description:
        "Get the actual rules (permission sets + scope, each as project_ids or organization_id) attached to a " +
        "Policy. Use this, not scaleway_iam_get_policy, to see what a policy really grants.",
      inputSchema: rulesIdSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ policy_id }) =>
      withIamErrorHandling(async () => {
        const data = await iamRequest<{ rules: Rule[]; total_count: number }>(config, "GET", `/rules?policy_id=${policy_id}`);
        return toolJsonResult(data, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_set_policy_rules",
    {
      title: "Set rules on a Scaleway IAM Policy",
      description:
        "Overwrite the COMPLETE rules array on an existing Policy in one atomic call - the safe way to add or " +
        "remove a permission set on a live policy. Requires confirm=true. Prefer this over delete+recreate: " +
        "deleting a policy that grants its own holder IAMPolicyManager revokes that permission the instant " +
        "it's deleted, before a replacement can be created, which can lock the credential you're using out of " +
        "IAM entirely. Distinct lockout mode: a successful replace that drops this server's IAM-management " +
        "rule (IAMPolicyManager/IAMApplicationManager) cannot be undone through this server - the credential " +
        "then cannot call this tool, or any other IAM policy/application tool, to fix itself. Call " +
        "scaleway_iam_list_policy_rules first to get the current array before changing it.",
      inputSchema: setRulesSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ policy_id, rules, confirm }) =>
      withIamErrorHandling(async () => {
        const current = await iamRequest<{ rules: Rule[]; total_count: number }>(config, "GET", `/rules?policy_id=${policy_id}`);
        const currentSets = new Set((current.rules ?? []).flatMap((r) => r.permission_set_names));
        const incomingSets = new Set(rules.flatMap((r) => r.permission_set_names));
        const droppingPolicyManager = currentSets.has("IAMPolicyManager") && !incomingSets.has("IAMPolicyManager");
        const droppingApplicationManager =
          currentSets.has("IAMApplicationManager") && !incomingSets.has("IAMApplicationManager");
        if (droppingPolicyManager || droppingApplicationManager) {
          return toolError(
            "Refusing this replace: it would drop IAMPolicyManager and/or IAMApplicationManager from a policy " +
              "that currently grants them. That would permanently lock out IAM management for whoever this " +
              "policy currently grants it to. Include those permission sets in the replacement array.",
          );
        }
        const data = await iamRequest<{ rules: Rule[] }>(config, "PUT", `/rules`, { policy_id, rules });
        return toolJsonResult(data, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_policy",
    {
      title: "Delete Scaleway IAM Policy",
      description: "PERMANENTLY delete an IAM Policy. Requires confirm=true. Every permission it granted is revoked immediately.",
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ policy_id }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/policies/${policy_id}`);
        return toolJsonResult({ deleted: true, policy_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
