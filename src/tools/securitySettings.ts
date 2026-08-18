import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

/**
 * IAM Security Settings (issue #6) - org-wide auth policy. Live-probed 2026-08-18 (real fields
 * confirmed via a live GET, unlike SAML/SCIM this one is genuinely safe to read/no-op PATCH):
 * `GET /organizations/{id}/security-settings` -> {enforce_password_renewal, grace_period_duration,
 * login_attempts_before_locked, max_login_session_duration, max_api_key_expiration_duration}.
 * Real path IS org-nested, matching the issue spec here (unlike SAML/SCIM/JWTs, which needed
 * correction). A PATCH with an empty body round-tripped the current values unchanged - this one
 * genuinely follows "only passed fields change" semantics, it doesn't silently reset anything.
 */
interface SecuritySettings {
  enforce_password_renewal?: boolean;
  grace_period_duration?: string;
  login_attempts_before_locked?: number;
  max_login_session_duration?: string;
  max_api_key_expiration_duration?: string;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");

export function registerSecuritySettings(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_get_security_settings",
    {
      title: "Get the Organization's security settings",
      description:
        "Read org-wide auth policy: password-renewal enforcement, grace period duration, login-attempt lockout " +
        "threshold, max session/API-key-expiration durations.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      withIamErrorHandling(async () => {
        const s = await iamRequest<SecuritySettings>(config, "GET", `/organizations/${config.SCW_ORGANIZATION_ID}/security-settings`);
        return toolJsonResult(s, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_security_settings",
    {
      title: "Update the Organization's security settings",
      description:
        "Change org-wide auth policy. ORG-WIDE BLAST RADIUS, BOTH DIRECTIONS: tightening (e.g. lowering " +
        "login_attempts_before_locked, enabling enforce_password_renewal) can lock out users who haven't met the " +
        "new requirement yet; loosening (raising session/expiration durations) weakens the org's security posture " +
        "for everyone. Only the fields you pass are changed - live-verified that an empty call leaves every " +
        "current value untouched, unlike SAML/SCIM's enable endpoints (see docs/gotchas.md). Requires confirm=true.",
      inputSchema: {
        enforce_password_renewal: z.boolean().optional().describe("Force periodic password changes."),
        grace_period_duration: z.string().optional().describe("Grace period before a locked/expired account is fully revoked, e.g. '259200s' (3 days)."),
        login_attempts_before_locked: z.number().int().min(1).optional().describe("Failed login attempts before an account is locked."),
        max_login_session_duration: z.string().optional().describe("Max session lifetime, e.g. '2592000s' (30 days)."),
        max_api_key_expiration_duration: z.string().optional().describe("Max allowed API key expiration duration, e.g. '0s' for no cap."),
        confirm: confirmField.describe("Must be explicitly true - changes org-wide authentication policy."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ enforce_password_renewal, grace_period_duration, login_attempts_before_locked, max_login_session_duration, max_api_key_expiration_duration }) =>
      withIamErrorHandling(async () => {
        const s = await iamRequest<SecuritySettings>(config, "PATCH", `/organizations/${config.SCW_ORGANIZATION_ID}/security-settings`, {
          enforce_password_renewal,
          grace_period_duration,
          login_attempts_before_locked,
          max_login_session_duration,
          max_api_key_expiration_duration,
        });
        return toolJsonResult(s, config.MAX_OUTPUT_CHARS);
      }),
  );
}
