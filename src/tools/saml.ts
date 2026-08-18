import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

/**
 * IAM SAML SSO (issue #6) - org-wide, highest blast radius in this issue. Live-probed 2026-08-18:
 * the real path is `/organizations/{id}/saml` (the issue spec said flat `/saml`), and get/enable
 * is `POST /organizations/{id}/saml` - but **enable/update is DELETE/DISABLE via a DIFFERENT,
 * top-level path: `DELETE /saml/{saml_id}`** (not `/organizations/{id}/saml`, which 405s). See
 * docs/gotchas.md for the incident this was found from: an EMPTY POST body to this endpoint does
 * NOT validation-error like every other write endpoint in this API - it silently enables SAML
 * with a `missing_certificate` status. Every mutating tool here therefore requires its meaningful
 * fields as non-optional zod strings, specifically so this server can never send a near-empty body.
 * Certificates live at `/saml/{saml_id}/certificates` (confirmed via GET; POST shape unverified by
 * design - never sent a live create/enable call while building this after the incident above).
 */
interface SamlConfig {
  id: string;
  status?: string;
  service_provider?: { entity_id?: string; assertion_consumer_service_url?: string };
  entity_id?: string;
  single_sign_on_url?: string;
}

interface SamlCertificate {
  id: string;
  saml_id?: string;
  fingerprint?: string;
  created_at?: string | null;
  expires_at?: string | null;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");
const SAML_WARNING =
  "ORG-WIDE BLAST RADIUS: this changes how EVERYONE in the Organization signs in. A misconfigured IdP entity_id/SSO URL, or an expired/wrong certificate, can lock every user out of the console at once - console-based recovery is also gated by this policy if it fails. Verify the IdP-side configuration is correct BEFORE calling this, and keep at least one non-SAML login method (password) available on your own account as a fallback.";

export function registerSaml(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_get_saml_config",
    {
      title: "Get the Organization's SAML SSO configuration",
      description:
        "Read the Organization's SAML SSO config (status, entity IDs, ACS URL). Returns an error if SAML has " +
        "never been enabled for this Organization - that is the expected/default state, not a fault.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<SamlConfig>(config, "GET", `/organizations/${config.SCW_ORGANIZATION_ID}/saml`);
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_enable_saml",
    {
      title: "Enable SAML SSO for the Organization",
      description:
        `Enable SAML SSO, registering the identity provider's entity_id and SSO URL. ${SAML_WARNING} Requires ` +
        "confirm=true. The resulting config starts in status 'missing_certificate' until a certificate is added " +
        "via scaleway_iam_add_saml_certificate - SSO logins cannot succeed until then, so enabling alone does not " +
        "immediately expose a working (or misconfigurable) login path.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The identity provider's SAML entity ID (issuer URI)."),
        single_sign_on_url: z.string().url().describe("The identity provider's SSO redirect/POST URL."),
        confirm: confirmField.describe("Must be explicitly true - changes org-wide login configuration."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ entity_id, single_sign_on_url }) =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<SamlConfig>(config, "POST", `/organizations/${config.SCW_ORGANIZATION_ID}/saml`, {
          entity_id,
          single_sign_on_url,
        });
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_update_saml",
    {
      title: "Update the Organization's SAML SSO configuration",
      description: `Change the registered identity provider's entity_id/SSO URL. ${SAML_WARNING} Requires confirm=true.`,
      inputSchema: {
        entity_id: z.string().min(1).describe("The identity provider's SAML entity ID (issuer URI)."),
        single_sign_on_url: z.string().url().describe("The identity provider's SSO redirect/POST URL."),
        confirm: confirmField.describe("Must be explicitly true - changes org-wide login configuration."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ entity_id, single_sign_on_url }) =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<SamlConfig>(config, "POST", `/organizations/${config.SCW_ORGANIZATION_ID}/saml`, {
          entity_id,
          single_sign_on_url,
        });
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_disable_saml",
    {
      title: "Disable SAML SSO for the Organization",
      description:
        "PERMANENTLY remove the Organization's SAML SSO configuration. Requires confirm=true. Anyone who relies " +
        "on SSO to sign in falls back to password/other login methods - if they have none set, they are LOCKED " +
        "OUT. Confirmed via live probe: the working endpoint is a top-level DELETE by the SAML config's own id, " +
        "NOT the org-nested path (which 405s) - this tool fetches the config first to resolve that id.",
      inputSchema: { confirm: confirmField.describe("Must be explicitly true - removes org-wide SSO.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async () =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<SamlConfig>(config, "GET", `/organizations/${config.SCW_ORGANIZATION_ID}/saml`);
        await iamRequest<void>(config, "DELETE", `/saml/${c.id}`);
        return toolJsonResult({ disabled: true, saml_id: c.id }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_list_saml_certificates",
    {
      title: "List an Organization's SAML certificates",
      description: "List certificates registered for SAML SSO validation.",
      inputSchema: { saml_id: z.string().uuid().describe("From scaleway_iam_get_saml_config's id field.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ saml_id }) =>
      withIamErrorHandling(async () => {
        const data = await iamRequest<{ certificates?: SamlCertificate[] }>(config, "GET", `/saml/${saml_id}/certificates`);
        return toolJsonResult({ certificates: data.certificates ?? [] }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_add_saml_certificate",
    {
      title: "Add a SAML certificate",
      description:
        `Register a new signing certificate for SAML SSO. ${SAML_WARNING} Requires confirm=true. UNVERIFIED FIELD ` +
        "SHAPE: the exact request body was never live-tested while building this tool (to avoid repeating the " +
        "empty-body incident documented in docs/gotchas.md) - the PEM certificate is sent under 'certificate', " +
        "matching Scaleway's SAML certificate conventions elsewhere, but this is a best-effort guess pending a " +
        "real live test.",
      inputSchema: {
        saml_id: z.string().uuid().describe("From scaleway_iam_get_saml_config's id field."),
        certificate: z.string().min(1).describe("The PEM-encoded X.509 certificate the IdP uses to sign assertions."),
        confirm: confirmField.describe("Must be explicitly true - affects org-wide SSO validation."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ saml_id, certificate }) =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<SamlCertificate>(config, "POST", `/saml/${saml_id}/certificates`, { certificate });
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_saml_certificate",
    {
      title: "Get a SAML certificate",
      description:
        "Read one SAML certificate's metadata (fingerprint, expiry) by id. PATH UNCONFIRMED: " +
        "scaleway_iam_list_saml_certificates's path (/saml/{saml_id}/certificates) is live-verified; this " +
        "single-item path follows the same nesting convention but could not be confirmed without recreating a " +
        "live SAML config (deliberately avoided - see docs/gotchas.md). May need correction on first real use.",
      inputSchema: { saml_id: z.string().uuid(), certificate_id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ saml_id, certificate_id }) =>
      withIamErrorHandling(async () => {
        const c = await iamRequest<SamlCertificate>(config, "GET", `/saml/${saml_id}/certificates/${certificate_id}`);
        return toolJsonResult(c, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_saml_certificate",
    {
      title: "Delete a SAML certificate",
      description:
        "PERMANENTLY remove one SAML certificate. Requires confirm=true. If this is the certificate actively " +
        "validating SSO assertions, SSO breaks immediately for everyone until a replacement is added - check " +
        "scaleway_iam_list_saml_certificates for other valid certificates first if SSO must stay available. " +
        "PATH UNCONFIRMED - see scaleway_iam_get_saml_certificate's description.",
      inputSchema: { saml_id: z.string().uuid(), certificate_id: z.string().uuid(), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ saml_id, certificate_id }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/saml/${saml_id}/certificates/${certificate_id}`);
        return toolJsonResult({ deleted: true, certificate_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
