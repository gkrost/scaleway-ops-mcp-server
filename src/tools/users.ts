import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";

/**
 * IAM Users management (issue #4) - HUMAN identities, unlike applications.ts. Every mutating
 * tool's description makes the human impact explicit; destructive/lockout-capable ops are
 * confirm-guarded. Behavior facts live-probed 2026-08-18 (bogus-id error shapes, owner
 * detection via type === "owner", password 1-72 bytes admin-set, mfa boolean) - see
 * docs/gotchas.md. Create semantics (invite-vs-instant) are UNVERIFIED (no disposable mailbox
 * available) and labeled so in the create tool.
 */
interface User {
  id: string;
  email: string;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone_number?: string | null;
  locale?: string | null;
  status?: string | null;
  type?: string | null;
  locked?: boolean | null;
  mfa?: boolean | null;
  organization_id: string;
  created_at?: string | null;
  updated_at?: string | null;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");

function userView(u: User) {
  return {
    id: u.id,
    email: u.email,
    username: u.username ?? null,
    name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null,
    status: u.status ?? null,
    type: u.type ?? null,
    locked: u.locked ?? null,
    mfa_enabled: u.mfa ?? null,
    created_at: u.created_at ?? null,
  };
}

export function registerUsers(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_list_users",
    {
      title: "List Scaleway IAM Users",
      description:
        "List human Users of this Organization (the console's IAM > Users page) - id, email, status, type (owner/member/guest), locked and MFA flags. Needs IAMUserReadOnly/IAMUserManager on this server's credential.",
      inputSchema: {
        email: z.string().optional().describe("Filter by exact email address."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ email }) =>
      withIamErrorHandling(async () => {
        const params = new URLSearchParams({ organization_id: config.SCW_ORGANIZATION_ID });
        if (email) params.set("email", email);
        const users = await iamListAll<User>(config, `/users?${params}`, "users");
        return toolJsonResult({ total_count: users.length, users: users.map(userView) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_user",
    {
      title: "Get a Scaleway IAM User",
      description: "Read one human User by id - full profile incl. status, type, locked, MFA flags.",
      inputSchema: { user_id: z.string().uuid().describe("User ID from list_users.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "GET", `/users/${user_id}`);
        return toolJsonResult(userView(u), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_create_user",
    {
      title: "Create/invite a Scaleway IAM User",
      description:
        "Create a human User by email. SEMANTICS UNVERIFIED (2026-08-18): Scaleway's docs state users 'can only be invited to join' an Organization, yet the API exposes this create endpoint requiring a type field - most likely this sends the person an invitation/set-password email and creates a guest; that happy path could not be live-verified without a disposable mailbox. A REAL email is sent to the address on success - never call speculatively. Requires confirm=true. The API validates email format and a type ('guest' is the default here, inferred from the guest-only delete endpoint - also unverified).",
      inputSchema: {
        email: z.string().email().describe("The person's email address - receives the invitation."),
        type: z.enum(["guest", "member"]).default("guest").describe("User type. 'guest' default (inferred, unverified)."),
        tags: z.array(z.string()).optional(),
        confirm: confirmField.describe("Must be explicitly true - sends a real invitation email."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ email, type, tags }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "POST", "/users", {
          organization_id: config.SCW_ORGANIZATION_ID,
          email,
          type,
          tags,
        });
        return toolJsonResult({ created: userView(u), caveat: "invitation semantics unverified - see docs/gotchas.md" }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_user",
    {
      title: "Update a Scaleway IAM User",
      description:
        "Update a User's mutable profile fields (tags; name/email where the API allows - invalid fields are rejected with the API's own validation message). Only passed fields change.",
      inputSchema: {
        user_id: z.string().uuid(),
        tags: z.array(z.string()).optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id, tags, first_name, last_name }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "PATCH", `/users/${user_id}`, {
          tags,
          first_name,
          last_name,
        });
        return toolJsonResult(userView(u), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_user",
    {
      title: "Delete a Scaleway IAM User",
      description:
        "PERMANENTLY remove a User from this Organization. Requires confirm=true. Two guards: (1) this tool refuses to delete the Organization OWNER (type === 'owner') outright; (2) the API's own endpoint is guest-scoped ('Delete a guest user') - deleting a member/owner is rejected server-side and that error is surfaced verbatim. Live-probed 2026-08-18 on bogus ids only; guest happy-path unverified.",
      inputSchema: {
        user_id: z.string().uuid(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "GET", `/users/${user_id}`);
        if (u.type === "owner") {
          return toolError(
            `Refusing to delete ${user_id}: it is the Organization OWNER. Transfer ownership in the console before removing that account.`,
          );
        }
        await iamRequest<void>(config, "DELETE", `/users/${user_id}`);
        return toolJsonResult({ deleted: true, user_id, was_type: u.type ?? null }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_lock_user",
    {
      title: "Lock a Scaleway IAM User",
      description:
        "Lock a human User out of the Organization IMMEDIATELY (expected use: compromise response, offboarding). Requires confirm=true. This acts on a person, not a service - the console shows them as locked. Exact session/token invalidation timing unverified.",
      inputSchema: { user_id: z.string().uuid(), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "POST", `/users/${user_id}/lock`);
        return toolJsonResult({ locked: true, user: userView(u) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_unlock_user",
    {
      title: "Unlock a Scaleway IAM User",
      description: "Restore a locked User's access. Reversible counterpart of lock_user.",
      inputSchema: { user_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "POST", `/users/${user_id}/unlock`);
        return toolJsonResult({ locked: false, user: userView(u) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_user_password",
    {
      title: "Set a Scaleway IAM User's password (admin reset)",
      description:
        "ADMIN-SET password reset: the new password is supplied BY THE CALLER (API takes it explicitly, 1-72 bytes - live-probed) and takes effect immediately for the person's login. Account-takeover-grade power over a human - requires confirm=true. The password value travels in this tool call's arguments: generate a strong one, deliver it to the person over a separate secure channel, and never reuse an existing/known password. Whether active sessions are invalidated is unverified.",
      inputSchema: {
        user_id: z.string().uuid(),
        password: z.string().min(8).max(72).describe("The NEW password (1-72 bytes API limit; >=8 enforced here). Not returned in the response."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "POST", `/users/${user_id}/update-password`);
        return toolJsonResult({ password_set: true, user: userView(u) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_user_username",
    {
      title: "Change a Scaleway IAM User's username (login identity)",
      description:
        "Change what the person types to LOG IN. Requires confirm=true - they must be told, or they cannot sign in next time. Live-probed on bogus ids only (404 shape).",
      inputSchema: {
        user_id: z.string().uuid(),
        new_username: z.string().min(1).describe("The new login username."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id, new_username }) =>
      withIamErrorHandling(async () => {
        const u = await iamRequest<User>(config, "POST", `/users/${user_id}/update-username`, { username: new_username });
        return toolJsonResult({ username_set: true, user: userView(u) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_user_mfa_otp",
    {
      title: "Delete a Scaleway IAM User's MFA OTP factor",
      description:
        "Remove the person's TOTP MFA factor. SECURITY-WEAKENING on a human account - requires confirm=true. Expected legitimate use: lost authenticator recovery. Creating/enrolling a new OTP is deliberately NOT a tool here: enrollment requires the human's authenticator code to validate, and a created-but-unvalidated factor leaves MFA half-configured (flow states unprobed, endpoint shape live-verified 2026-08-18).",
      inputSchema: { user_id: z.string().uuid(), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/users/${user_id}/mfa-otp`);
        return toolJsonResult({ mfa_deleted: true, user_id }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_user_grace_periods",
    {
      title: "List a Scaleway IAM User's grace periods",
      description: "Read the User's grace periods (post-lock/deletion data-access windows). Read-only.",
      inputSchema: { user_id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ user_id }) =>
      withIamErrorHandling(async () => {
        const data = await iamRequest<Record<string, unknown>>(config, "GET", `/users/${user_id}/grace-periods`);
        return toolJsonResult(data, config.MAX_OUTPUT_CHARS);
      }),
  );
}
