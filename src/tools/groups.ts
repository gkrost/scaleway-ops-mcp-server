import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";

/**
 * IAM Groups (issue #5) - completes the group_id principal loop policies.ts already accepts.
 * Live-probed 2026-08-18. Two corrections from the issue's own spec (itself accurate for the
 * member-mutation endpoints, both confirmed via the target-group-doesn't-exist trick - any body
 * sent to a bogus group id can only ever 400/404, never mutate anything real):
 *  - `list_groups`'s array filters (`group_ids`/`user_ids`/`application_ids`) are plain REPEATED
 *    query params (`?group_ids=a&group_ids=b`), NOT bracket-suffixed (`group_ids[]=...` -> 400).
 *  - `name` is an EXACT match, not a substring filter (confirmed: "Admin" -> 0 results,
 *    "Administrators" -> 1) - unlike permissionSets.ts's client-side name_filter.
 * This org has no `managed`/`all_users`/`all_applications` groups to test that half of the
 * refusal guard against live (all 3 preset groups read `managed: false`). The guard also
 * refuses `editable=false` / `deletable=false`, and runs on every membership mutation
 * (add/remove/set) as well as update/delete.
 */
interface Group {
  id: string;
  created_at?: string | null;
  updated_at?: string | null;
  organization_id: string;
  name: string;
  description?: string | null;
  user_ids: string[];
  application_ids: string[];
  tags: string[];
  editable: boolean;
  deletable: boolean;
  managed: boolean;
  all_users: boolean;
  all_applications: boolean;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");
const groupIdField = z.string().uuid().describe("Group ID, from scaleway_iam_list_groups.");

function groupView(g: Group) {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    user_ids: g.user_ids,
    application_ids: g.application_ids,
    tags: g.tags,
    managed: g.managed,
    all_users: g.all_users,
    all_applications: g.all_applications,
    editable: g.editable,
    deletable: g.deletable,
  };
}

function refuseIfSpecial(
  g: Group,
  action: string,
  opts: { needEditable?: boolean; needDeletable?: boolean } = {},
): string | null {
  if (g.managed || g.all_users || g.all_applications) {
    const which = g.all_users
      ? "the 'All Users' group"
      : g.all_applications
        ? "the 'All Applications' group"
        : "a Scaleway-managed group";
    return `Refusing to ${action} ${g.id}: it is ${which} (managed=${g.managed}, all_users=${g.all_users}, all_applications=${g.all_applications}). These are provisioned by Scaleway and not meant to be edited/deleted here - the API itself is also expected to reject it.`;
  }
  // Spec: special groups are also editable=false / deletable=false. This org's preset
  // Administrators/Editors/Billing groups report managed=false, so the flags above never fire
  // on them — the editable/deletable bits are what would actually refuse those presets.
  if (opts.needEditable && g.editable === false) {
    return `Refusing to ${action} ${g.id} (${g.name}): editable=false.`;
  }
  if (opts.needDeletable && g.deletable === false) {
    return `Refusing to ${action} ${g.id} (${g.name}): deletable=false.`;
  }
  return null;
}

export function registerGroups(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_list_groups",
    {
      title: "List Scaleway IAM Groups",
      description:
        "List Groups in the Organization, including Scaleway's preset groups (Administrators/Editors/Billing " +
        "Administrators) and any special managed groups. 'name' is an EXACT match, not a substring filter. Array " +
        "filters (group_ids/user_ids/application_ids) narrow to groups matching ANY of the given ids.",
      inputSchema: {
        name: z.string().optional().describe("Exact group name to filter by."),
        tag: z.string().optional().describe("Filter to groups carrying this exact tag."),
        group_ids: z.array(z.string().uuid()).optional().describe("Only these group ids."),
        user_ids: z.array(z.string().uuid()).optional().describe("Only groups containing any of these users."),
        application_ids: z.array(z.string().uuid()).optional().describe("Only groups containing any of these applications."),
        order_by: z.enum(["created_at_asc", "created_at_desc", "updated_at_asc", "updated_at_desc", "name_asc", "name_desc"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, tag, group_ids, user_ids, application_ids, order_by }) =>
      withIamErrorHandling(async () => {
        const params = new URLSearchParams({ organization_id: config.SCW_ORGANIZATION_ID });
        if (name) params.set("name", name);
        if (tag) params.set("tag", tag);
        if (order_by) params.set("order_by", order_by);
        for (const id of group_ids ?? []) params.append("group_ids", id);
        for (const id of user_ids ?? []) params.append("user_ids", id);
        for (const id of application_ids ?? []) params.append("application_ids", id);
        const groups = await iamListAll<Group>(config, `/groups?${params}`, "groups");
        return toolJsonResult({ total_count: groups.length, groups: groups.map(groupView) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_group",
    {
      title: "Get a Scaleway IAM Group",
      description: "Read one Group's full details, including its complete member lists (user_ids/application_ids) and special-group flags (managed/all_users/all_applications).",
      inputSchema: { group_id: groupIdField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id }) =>
      withIamErrorHandling(async () => {
        const g = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_create_group",
    {
      title: "Create a Scaleway IAM Group",
      description:
        "Create a new, empty Group. No confirm needed - fully reversible, grants nothing to anyone until members " +
        "are added and/or a Policy is attached to its group_id. Name must be unique in the Organization (max 64 " +
        "chars) - re-creating the same name immediately after deleting a group with that name may hit a brief " +
        "uniqueness lag (seen elsewhere in this API, e.g. Applications).",
      inputSchema: {
        name: z.string().min(1).max(64),
        description: z.string().max(200).optional(),
        tags: z.array(z.string()).max(10).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, description, tags }) =>
      withIamErrorHandling(async () => {
        const g = await iamRequest<Group>(config, "POST", "/groups", {
          organization_id: config.SCW_ORGANIZATION_ID,
          name,
          description,
          tags,
        });
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_group",
    {
      title: "Update a Scaleway IAM Group",
      description: "Change a Group's name/description/tags. Only passed fields change. Refuses Scaleway-managed/special groups tool-side.",
      inputSchema: {
        group_id: groupIdField,
        name: z.string().min(1).max(64).optional(),
        description: z.string().max(200).optional(),
        tags: z.array(z.string()).max(10).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, name, description, tags }) =>
      withIamErrorHandling(async () => {
        if (name === undefined && description === undefined && tags === undefined) {
          return toolError("Provide at least one of name, description, or tags.");
        }
        const current = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        const refusal = refuseIfSpecial(current, "update", { needEditable: true });
        if (refusal) return toolError(refusal);
        const g = await iamRequest<Group>(config, "PATCH", `/groups/${group_id}`, { name, description, tags });
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_group",
    {
      title: "Delete a Scaleway IAM Group",
      description:
        "PERMANENTLY delete a Group. Requires confirm=true. IRREVERSIBLE: any Policy granting access via this " +
        "group's group_id stops applying to its former members immediately - anyone relying solely on this " +
        "group's grants loses that access. Refuses Scaleway-managed/special groups (all_users/all_applications) " +
        "tool-side - fetches the group first to check.",
      inputSchema: { group_id: groupIdField, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ group_id }) =>
      withIamErrorHandling(async () => {
        const current = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        const refusal = refuseIfSpecial(current, "delete", { needDeletable: true });
        if (refusal) return toolError(refusal);
        await iamRequest<void>(config, "DELETE", `/groups/${group_id}`);
        return toolJsonResult({ deleted: true, group_id }, config.MAX_OUTPUT_CHARS);
      }),
  );

  const memberRefSchema = {
    group_id: groupIdField,
    user_id: z.string().uuid().optional().describe("A human User's id to add/remove."),
    application_id: z.string().uuid().optional().describe("An Application's id to add/remove."),
  };

  function requireAtLeastOneMember(user_id?: string, application_id?: string): string | null {
    if (!user_id && !application_id) return "Provide at least one of user_id or application_id.";
    return null;
  }

  server.registerTool(
    "scaleway_iam_add_group_member",
    {
      title: "Add one member to a Scaleway IAM Group",
      description:
        "Add one User and/or one Application to a Group in a single call (both may be given at once - it's not " +
        "either/or). Grants that member every permission any Policy attaches to this group's group_id, " +
        "immediately. Existing members are preserved. Refuses Scaleway-managed/special or non-editable groups.",
      inputSchema: memberRefSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ group_id, user_id, application_id }) =>
      withIamErrorHandling(async () => {
        const err = requireAtLeastOneMember(user_id, application_id);
        if (err) return toolError(err);
        const current = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        const refusal = refuseIfSpecial(current, "add a member to", { needEditable: true });
        if (refusal) return toolError(refusal);
        const g = await iamRequest<Group>(config, "POST", `/groups/${group_id}/add-member`, { user_id, application_id });
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_add_group_members",
    {
      title: "Add multiple members to a Scaleway IAM Group",
      description:
        "Add multiple Users and/or Applications to a Group at once. Existing members are preserved - this is " +
        "additive, not a replace. Refuses Scaleway-managed/special or non-editable groups.",
      inputSchema: {
        group_id: groupIdField,
        user_ids: z.array(z.string().uuid()).optional(),
        application_ids: z.array(z.string().uuid()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ group_id, user_ids, application_ids }) =>
      withIamErrorHandling(async () => {
        if (!user_ids?.length && !application_ids?.length) {
          return toolError("Provide at least one of user_ids or application_ids.");
        }
        const current = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        const refusal = refuseIfSpecial(current, "add members to", { needEditable: true });
        if (refusal) return toolError(refusal);
        const g = await iamRequest<Group>(config, "POST", `/groups/${group_id}/add-members`, { user_ids, application_ids });
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_set_group_members",
    {
      title: "Overwrite a Scaleway IAM Group's entire membership",
      description:
        "FULL-REPLACE a Group's membership: the given user_ids/application_ids become the COMPLETE member list - " +
        "anyone currently a member but NOT in either list is REMOVED, losing this group's grants immediately. " +
        "Requires confirm=true. Pass empty arrays to remove everyone. Refuses Scaleway-managed/special groups.",
      inputSchema: {
        group_id: groupIdField,
        user_ids: z.array(z.string().uuid()).describe("The COMPLETE list of member user ids - omitted ones are removed."),
        application_ids: z.array(z.string().uuid()).describe("The COMPLETE list of member application ids - omitted ones are removed."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, user_ids, application_ids }) =>
      withIamErrorHandling(async () => {
        const current = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        const refusal = refuseIfSpecial(current, "overwrite membership of", { needEditable: true });
        if (refusal) return toolError(refusal);
        await iamRequest<void>(config, "PUT", `/groups/${group_id}/members`, { user_ids, application_ids });
        const g = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_remove_group_member",
    {
      title: "Remove one member from a Scaleway IAM Group",
      description:
        "Remove one User and/or one Application from a Group. Requires confirm=true. That member immediately " +
        "loses every permission this group's attached Policies granted them - check they don't rely solely on " +
        "this group for access they still need. Refuses Scaleway-managed/special or non-editable groups.",
      inputSchema: { ...memberRefSchema, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ group_id, user_id, application_id }) =>
      withIamErrorHandling(async () => {
        const err = requireAtLeastOneMember(user_id, application_id);
        if (err) return toolError(err);
        const current = await iamRequest<Group>(config, "GET", `/groups/${group_id}`);
        const refusal = refuseIfSpecial(current, "remove a member from", { needEditable: true });
        if (refusal) return toolError(refusal);
        const g = await iamRequest<Group>(config, "POST", `/groups/${group_id}/remove-member`, { user_id, application_id });
        return toolJsonResult(groupView(g), config.MAX_OUTPUT_CHARS);
      }),
  );
}
