import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

interface PermissionSet {
  id: string;
  name: string;
  scope_type: "organization" | "project" | "projects";
  description: string;
  categories: string[];
}

const inputSchema = {
  name_filter: z.string().optional().describe("Case-insensitive substring filter on permission set name, e.g. 'ObjectStorage' or 'IAM'."),
};

export function registerPermissionSets(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_list_permission_sets",
    {
      title: "List Scaleway IAM Permission Sets",
      description:
        "List every permission set Scaleway IAM policies can grant (e.g. ObjectStorageReadOnly, IAMPolicyManager). " +
        "Each entry's `scope_type` is 'organization' or 'projects' - a single policy rule can only combine " +
        "permission sets that share the SAME scope_type (mixing them fails with 'permission sets must be of the " +
        "same scope type'); use separate rules for each scope_type instead. " +
        "Call this BEFORE scaleway_iam_create_policy to confirm exact names and scope_types - guessing a name or " +
        "assuming its scope produces an actionable-but-late 400/invalid_arguments error.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name_filter }) =>
      withIamErrorHandling(async () => {
        const allSets = await iamListAll<PermissionSet>(
          config,
          `/permission-sets?organization_id=${config.SCW_ORGANIZATION_ID}`,
          "permission_sets",
        );
        let sets = allSets;
        if (name_filter) {
          const needle = name_filter.toLowerCase();
          sets = sets.filter((s) => s.name.toLowerCase().includes(needle));
        }
        return toolJsonResult(
          {
            total_count: allSets.length,
            count: sets.length,
            permission_sets: sets.map((s) => ({
              name: s.name,
              scope_type: s.scope_type,
              description: s.description,
              categories: s.categories,
            })),
          },
          config.MAX_OUTPUT_CHARS,
        );
      }),
  );
}
