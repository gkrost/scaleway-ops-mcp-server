import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult } from "../output.js";

/**
 * IAM JWTs (issue #6) - browser/console session tokens, NOT API keys. Live-probed 2026-08-18:
 * the real path is `/jwts` (plural - the issue spec said `/jwt`) and it requires `audience_id`
 * (a user_id), not `organization_id`. Even with the credential's policy extended to full
 * `IAMManager`, `list`/`get` still 403 with resource `self_jwt` - the action name strongly
 * suggests this surface is scoped to a session's OWN JWTs, which an Application/API-key
 * credential (this server's auth model) structurally has none of, no permission grant can change
 * that. Implemented per the corrected path/params and left live-unverified beyond that 403 -
 * see docs/gotchas.md.
 */
interface Jwt {
  jti: string;
  issuer_id?: string;
  audience_id: string;
  expires_at?: string | null;
  created_at?: string | null;
  ip?: string | null;
  user_agent?: string | null;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");

export function registerJwts(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_list_jwts",
    {
      title: "List a User's active JWTs (browser/console sessions)",
      description:
        "List active JWT sessions (browser/console logins) for one User. NOT the same as API keys - these are " +
        "interactive-login session tokens. Live-probed 2026-08-18: this server's Application/API-key credential " +
        "gets 403 'insufficient permissions' on resource 'self_jwt' even with full IAMManager - the surface appears " +
        "scoped to a session's own JWTs, which an API-key credential never has. May only be callable from a " +
        "human's own session context, not from this server. Reports the error verbatim if so.",
      inputSchema: { audience_id: z.string().uuid().describe("The User ID whose sessions to list (from scaleway_iam_list_users).") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ audience_id }) =>
      withIamErrorHandling(async () => {
        const data = await iamRequest<{ jwts?: Jwt[]; total_count?: number }>(config, "GET", `/jwts?audience_id=${audience_id}`);
        return toolJsonResult({ total_count: data.total_count ?? (data.jwts ?? []).length, jwts: data.jwts ?? [] }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_jwt",
    {
      title: "Get one JWT session by id",
      description: "Read one JWT session's metadata (jti, audience, expiry, IP, user agent) by its id.",
      inputSchema: { jti: z.string().describe("The JWT's id (jti claim), from scaleway_iam_list_jwts.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ jti }) =>
      withIamErrorHandling(async () => {
        const j = await iamRequest<Jwt>(config, "GET", `/jwts/${jti}`);
        return toolJsonResult(j, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_jwt",
    {
      title: "Revoke a JWT session",
      description:
        "Immediately invalidate one active browser/console session. Requires confirm=true. Whoever holds that " +
        "session is signed out right away - same severity as revoking an API key, but for an interactive login " +
        "instead of a programmatic credential.",
      inputSchema: { jti: z.string(), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ jti }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/jwts/${jti}`);
        return toolJsonResult({ deleted: true, jti }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
