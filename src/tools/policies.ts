import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

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
  rules: Rule[];
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
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  application_id: z.string().uuid().optional().describe("Attach this policy to an Application. Omit application_id/user_id/group_id to create a policy with no principal yet."),
  user_id: z.string().uuid().optional(),
  group_id: z.string().uuid().optional(),
  rules: z
    .array(ruleSchema)
    .min(1)
    .describe("One rule per scope_type needed. E.g. one rule with organization_id + ['IAMPolicyManager'], a second with project_ids + ['ObjectStorageFullAccess']."),
};

const listSchema = {
  application_id: z.string().uuid().optional().describe("Filter to policies attached to one Application."),
};

const getSchema = {
  policy_id: z.string().uuid(),
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
      description: "Get one IAM Policy by id, including its full rules array (permission sets + scope per rule).",
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
