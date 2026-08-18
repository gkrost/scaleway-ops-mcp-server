import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

/**
 * IAM SCIM provisioning (issue #6). Live-probed 2026-08-18: get is `/organizations/{id}/scim`
 * (issue spec said flat `/scim`); disable is a top-level `DELETE /scim/{scim_id}` (the org-nested
 * path 405s, same pattern as SAML). CRITICAL: `POST /organizations/{id}/scim` with an empty body
 * does NOT validation-error - it silently enables SCIM outright (no fields at all in the response
 * besides id/created_at). See docs/gotchas.md for the live incident this was found from.
 * `enable_scim` therefore takes no configurable fields (there don't appear to be any) but still
 * requires confirm=true given what enabling it does. Tokens live at `/scim/{scim_id}/tokens`
 * (confirmed via GET); single-token get/delete path unconfirmed - see scaleway_iam_delete_scim_token.
 */
interface ScimConfig {
  id: string;
  created_at?: string | null;
}

interface ScimToken {
  id: string;
  token?: string;
  description?: string;
  created_at?: string | null;
  expires_at?: string | null;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");

export function registerScim(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_get_scim_config",
    {
      title: "Get the Organization's SCIM provisioning configuration",
      description: "Read the Organization's SCIM config (id, created_at). Returns an error if SCIM was never enabled - that is the expected default state.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<ScimConfig>(config, "GET", `/organizations/${config.SCW_ORGANIZATION_ID}/scim`);
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_enable_scim",
    {
      title: "Enable SCIM provisioning for the Organization",
      description:
        "Enable SCIM (lets an external identity provider create/update/deactivate Users automatically). Requires " +
        "confirm=true. Live-probed 2026-08-18: this endpoint takes no request fields - enabling alone does not " +
        "grant any provisioning access by itself, a token must be created separately " +
        "(scaleway_iam_create_scim_token) and configured in the IdP before anything can actually provision.",
      inputSchema: { confirm: confirmField.describe("Must be explicitly true - enables org-wide SCIM provisioning.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<ScimConfig>(config, "POST", `/organizations/${config.SCW_ORGANIZATION_ID}/scim`, {});
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_disable_scim",
    {
      title: "Disable SCIM provisioning for the Organization",
      description:
        "PERMANENTLY disable SCIM. Requires confirm=true. Provisioning from the IdP stops immediately - including " +
        "DEPROVISIONING: if the IdP was the mechanism offboarding relies on to remove departed Users, that stops " +
        "working silently until re-enabled. Confirmed via live probe: the working endpoint is a top-level DELETE " +
        "by the SCIM config's own id, NOT the org-nested path (which 405s) - this tool fetches the config first.",
      inputSchema: { confirm: confirmField.describe("Must be explicitly true - removes org-wide SCIM provisioning.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async () =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<ScimConfig>(config, "GET", `/organizations/${config.SCW_ORGANIZATION_ID}/scim`);
        await iamRequest<void>(config, "DELETE", `/scim/${c.id}`);
        return toolJsonResult({ disabled: true, scim_id: c.id }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_scim_tokens",
    {
      title: "List an Organization's SCIM tokens",
      description: "List SCIM provisioning tokens. Never includes the token secret (only visible once, at creation, per scaleway_iam_create_scim_token).",
      inputSchema: { scim_id: z.string().uuid().describe("From scaleway_iam_get_scim_config's id field.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ scim_id }) =>
      withIamErrorHandling(async () => {
        const data = await iamRequest<{ tokens?: ScimToken[] }>(config, "GET", `/scim/${scim_id}/tokens`);
        return toolJsonResult({ tokens: (data.tokens ?? []).map((t) => ({ id: t.id, description: t.description, created_at: t.created_at, expires_at: t.expires_at })) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_create_scim_token",
    {
      title: "Create a SCIM provisioning token",
      description:
        "Generate a new SCIM token. IMPORTANT: like an API key's secret, this token is returned ONLY in this " +
        "response - capture it immediately and configure it in the identity provider, it cannot be re-fetched " +
        "later. Requires confirm=true - this token grants the IdP power to create/modify/deactivate Users. FIELD " +
        "SHAPE UNVERIFIED: never live-tested (see docs/gotchas.md) - 'description' is a best-effort guess matching " +
        "every other credential-creation tool's convention in this server.",
      inputSchema: {
        scim_id: z.string().uuid().describe("From scaleway_iam_get_scim_config's id field."),
        description: z.string().max(200).describe("What this token is for, e.g. the IdP's name."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ scim_id, description }) =>
      withIamErrorHandling(async () => {
        const t = await iamRequest<ScimToken>(config, "POST", `/scim/${scim_id}/tokens`, { description });
        return toolJsonResult(t, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_scim_token",
    {
      title: "Delete a SCIM provisioning token",
      description:
        "PERMANENTLY revoke a SCIM token. Requires confirm=true. IdP provisioning breaks immediately until a new " +
        "token is created and configured in the IdP. PATH UNCONFIRMED: follows the same nesting convention as " +
        "scaleway_iam_list_scim_tokens (/scim/{scim_id}/tokens) but the single-item path could not be live-" +
        "verified without recreating a live SCIM config - deliberately avoided, see docs/gotchas.md.",
      inputSchema: { scim_id: z.string().uuid(), token_id: z.string().uuid(), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ scim_id, token_id }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/scim/${scim_id}/tokens/${token_id}`);
        return toolJsonResult({ deleted: true, token_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
