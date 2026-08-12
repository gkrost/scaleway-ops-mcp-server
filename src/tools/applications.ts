import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

interface Application {
  id: string;
  name: string;
  description: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
  editable: boolean;
  nb_api_keys: number;
}

const createSchema = {
  name: z
    .string()
    .min(1)
    .max(200)
    .describe("Application name. Convention in this org: '<purpose>-least-privilege' for narrowly-scoped operational identities."),
  description: z.string().max(1000).optional().describe("What this Application is for and why - shown in the console, helps future readers."),
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
        "Requires confirm=true.",
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ application_id }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/applications/${application_id}`);
        return toolJsonResult({ deleted: true, application_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
