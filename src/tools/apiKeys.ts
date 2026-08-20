import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";

interface ApiKey {
  access_key: string;
  secret_key?: string;
  application_id?: string;
  user_id?: string;
  description: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  default_project_id?: string;
  creation_ip: string;
}

const createSchema = {
  application_id: z.string().uuid().describe("The Application this key authenticates as. Get it from scaleway_iam_create_application or scaleway_iam_list_applications."),
  description: z.string().max(200).describe("What this key is for - shown in the console key list, the only way to tell keys apart later."),
  expires_at: z
    .string()
    .datetime()
    .optional()
    .describe(
      "RFC3339 timestamp, e.g. '2027-08-12T00:00:00Z'. Omit for a key that never expires - appropriate for a durable " +
        "operational credential (e.g. one a cron job or deployed service uses), NOT for a throwaway/bootstrap key, " +
        "which should get a short expiry instead.",
    ),
  default_project_id: z
    .string()
    .uuid()
    .optional()
    .describe("Preferred Project for Object Storage operations with this key. Required if this key will call the S3-compatible API (bucket policies, objects)."),
};

const accessKeyFormat = /^[A-Za-z0-9]+$/;

const updateSchema = {
  access_key: z
    .string()
    .min(1)
    .regex(accessKeyFormat, "access_key is alphanumeric only")
    .describe("The access_key (not secret_key) of the key to update, e.g. 'SCWXXXXXXXXXXXXXXXXX'."),
  description: z.string().max(200).optional().describe("New description. Omit to leave unchanged."),
  expires_at: z
    .string()
    .datetime()
    .optional()
    .describe("New RFC3339 expiry, e.g. '2027-08-12T00:00:00Z'. Omit to leave unchanged - there is no way to clear an existing expiry back to 'never', only to set a new one."),
  default_project_id: z.string().uuid().optional().describe("New default Project for Object Storage operations with this key. Omit to leave unchanged."),
};

const listSchema = {
  application_id: z.string().uuid().optional().describe("Filter to keys belonging to one Application. Omit to list all keys in the Organization."),
};

const deleteSchema = {
  access_key: z
    .string()
    .min(1)
    .regex(accessKeyFormat, "access_key is alphanumeric only")
    .describe("The access_key (not secret_key) identifying the key to delete, e.g. 'SCWXXXXXXXXXXXXXXXXX'."),
  confirm: z.literal(true).describe("Must be explicitly true. Deletion is immediate and irreversible - anything using this key stops authenticating right away."),
};

/** Allow-list for list/update results. Omits `secret_key` (only returned at creation). */
function apiKeyView(key: ApiKey) {
  return {
    access_key: key.access_key,
    application_id: key.application_id ?? null,
    user_id: key.user_id ?? null,
    description: key.description,
    created_at: key.created_at,
    updated_at: key.updated_at,
    expires_at: key.expires_at ?? null,
    default_project_id: key.default_project_id ?? null,
    creation_ip: key.creation_ip,
  };
}

export function registerApiKeys(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_create_api_key",
    {
      title: "Create Scaleway API Key",
      description:
        "Generate a new API key (access_key + secret_key pair) for an Application. " +
        "IMPORTANT: secret_key is returned ONLY in this response - Scaleway never shows it again, and there is no " +
        "recovery endpoint. The caller MUST capture it immediately (e.g. write straight to the target host's env " +
        "file or a secret manager) rather than just printing it, since it cannot be re-fetched later - only revoked " +
        "and replaced with a new key. Each call mints a real, immediately-active credential; don't call this " +
        "speculatively.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ application_id, description, expires_at, default_project_id }) =>
      withIamErrorHandling(async () => {
        const key = await iamRequest<ApiKey>(config, "POST", "/api-keys", {
          application_id,
          description,
          expires_at,
          default_project_id,
        });
        return toolJsonResult(key, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_api_key",
    {
      title: "Update Scaleway API Key",
      description:
        "Change an existing API key's description, expiry, or default_project_id WITHOUT rotating its secret - " +
        "the access_key/secret_key pair itself never changes. Use this instead of delete+recreate for a metadata-" +
        "only change (e.g. extending an expiry before it lapses, or fixing a stale description); delete+recreate " +
        "would mint a new secret and break anything already deployed with the old one. Only the fields you pass " +
        "are changed; omitted fields are left as-is.",
      inputSchema: updateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ access_key, description, expires_at, default_project_id }) =>
      withIamErrorHandling(async () => {
        const key = await iamRequest<ApiKey>(config, "PATCH", `/api-keys/${access_key}`, {
          description,
          expires_at,
          default_project_id,
        });
        return toolJsonResult(apiKeyView(key), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_api_keys",
    {
      title: "List Scaleway API Keys",
      description: "List API keys in this Organization (never includes secret_key - only visible once, at creation). Optionally filter to one Application.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ application_id }) =>
      withIamErrorHandling(async () => {
        const params = new URLSearchParams({ organization_id: config.SCW_ORGANIZATION_ID });
        if (application_id) params.set("application_id", application_id);
        const all = await iamListAll<ApiKey>(config, `/api-keys?${params}`, "api_keys");
        return toolJsonResult({ total_count: all.length, count: all.length, api_keys: all.map(apiKeyView) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_api_key",
    {
      title: "Delete Scaleway API Key",
      description:
        "PERMANENTLY revoke an API key by its access_key. Requires confirm=true. Irreversible - anything using this " +
        "key stops authenticating immediately. Refused (even with confirm=true) when access_key is THIS server's " +
        "own operating credential (SCW_ACCESS_KEY): deleting it would not just revoke one permission, it would " +
        "revoke every capability this server has - IAM, S3, Audit Trail, all of it - immediately, with no way to " +
        "undo it through this server (the credential needed to create a replacement is the one just deleted).",
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ access_key }) =>
      withIamErrorHandling(async () => {
        if (access_key === config.SCW_ACCESS_KEY) {
          return toolError(
            `Refusing to delete ${access_key}: it is THIS server's own operating credential (SCW_ACCESS_KEY). ` +
              "Deleting it would revoke every capability this server has, not just IAM management, and there is " +
              "no way to undo it through this server afterward - the credential needed to create a replacement " +
              "key is the one just deleted. This is refused even with confirm=true. Create a replacement key on " +
              "the Application first (scaleway_iam_create_api_key), redeploy this server with it, and only then " +
              "delete the old one.",
          );
        }
        await iamRequest<void>(config, "DELETE", `/api-keys/${access_key}`);
        return toolJsonResult({ deleted: true, access_key }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
