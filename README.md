# scaleway-ops-mcp-server

[![CI](https://github.com/gkrost/scaleway-ops-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/gkrost/scaleway-ops-mcp-server/actions/workflows/ci.yml)

MCP server for Scaleway IAM (Applications, API keys, Policies, Permission sets) and Object
Storage Bucket Policy management.

## Why this exists

Provisioning a scoped Scaleway credential for a new service (create an IAM Application, mint its
API key, attach an IAM Policy, attach a Bucket Policy on the target bucket) is a recurring task
that was previously done by hand through the web console. This server wraps the real Scaleway API
so an agent can do it via tool calls instead - see [`docs/gotchas.md`](docs/gotchas.md) for the
non-obvious parts of that API this server exists to paper over.

## Setup

```bash
npm install
npm run build
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `SCW_ACCESS_KEY` | yes | Access key of the credential this server authenticates as. |
| `SCW_SECRET_KEY` | yes | Secret key. Used as `X-Auth-Token` for the IAM API and as the SigV4 secret for S3 calls. |
| `SCW_ORGANIZATION_ID` | yes | Organization these operations run in. |
| `SCW_PROJECT_ID` | yes | Default Project (used as `default_project_id` when creating API keys, and wherever a Project id is needed but not explicitly passed). |
| `SCW_DEFAULT_REGION` | no (default `fr-par`) | Region for Bucket Policy calls when a tool call doesn't specify one. |
| `MAX_OUTPUT_CHARS` | no (default `25000`) | Truncation limit for tool responses. |
| `MAX_PUT_OBJECT_BYTES` | no (default `5000000`) | Decoded-size ceiling for `scaleway_s3_put_object` - single-part only, multipart is out of scope. |
| `MAX_GET_OBJECT_BYTES` | no (default `5000000`) | Decoded-size ceiling for `scaleway_s3_get_object` - larger objects should use `scaleway_s3_generate_presigned_url`. |

**The credential this server runs as needs its own IAM Policy** granting (at minimum)
`IAMApplicationManager` + `IAMPolicyManager` (organization scope) and `ObjectStorageFullAccess`
(project scope) - see `docs/gotchas.md` for why these must be two separate policy rules. Create a
dedicated IAM Application for this server (don't reuse a human user's credential or an
Application scoped for something else) and grant it only what the table above needs.

## Running

Via Claude Code / any MCP client, as a stdio server. Simplest, via `npx` (no local clone needed):

```json
{
  "mcpServers": {
    "scaleway-ops": {
      "command": "npx",
      "args": ["-y", "scaleway-ops-mcp-server"],
      "env": {
        "SCW_ACCESS_KEY": "...",
        "SCW_SECRET_KEY": "...",
        "SCW_ORGANIZATION_ID": "...",
        "SCW_PROJECT_ID": "..."
      }
    }
  }
}
```

Or from a local clone/build, useful for development or pinning to an unreleased commit:

```json
{
  "mcpServers": {
    "scaleway-ops": {
      "command": "node",
      "args": ["/absolute/path/to/scaleway-ops-mcp-server/dist/index.js"],
      "env": {
        "SCW_ACCESS_KEY": "...",
        "SCW_SECRET_KEY": "...",
        "SCW_ORGANIZATION_ID": "...",
        "SCW_PROJECT_ID": "..."
      }
    }
  }
}
```

## Tools

**IAM Applications**
- `scaleway_iam_create_application`, `scaleway_iam_list_applications`, `scaleway_iam_get_application`, `scaleway_iam_update_application`, `scaleway_iam_delete_application`

**IAM API keys**
- `scaleway_iam_create_api_key`, `scaleway_iam_list_api_keys`, `scaleway_iam_update_api_key`, `scaleway_iam_delete_api_key`
- `update_api_key` covers `description`/`expires_at`/`default_project_id` only - the access_key/secret_key pair never changes, so it never rotates the credential.

**IAM Policies**
- `scaleway_iam_create_policy`, `scaleway_iam_list_policies`, `scaleway_iam_get_policy`, `scaleway_iam_update_policy`, `scaleway_iam_delete_policy`
- `update_policy` covers `name`/`description`/`tags` only. For `rules`, use the two tools below - `get_policy` never returns them.

**IAM Policy rules** (separate endpoint from the Policy object itself - see `docs/gotchas.md`)
- `scaleway_iam_list_policy_rules`, `scaleway_iam_set_policy_rules` (atomic full-replace `PUT`, no delete+recreate lockout risk)

**IAM Users** (human identities, issue #4; invite semantics unverified - see gotchas)
- `scaleway_iam_list_users`, `scaleway_iam_get_user`
- `scaleway_iam_create_user` (confirm-guarded; sends a real invitation email - semantics unverified without a disposable mailbox)
- `scaleway_iam_update_user` (profile fields), `scaleway_iam_delete_user` (confirm + owner-refused + guest-scoped API errors surfaced)
- `scaleway_iam_lock_user` / `scaleway_iam_unlock_user` (lock is confirm-guarded - acts on a person)
- `scaleway_iam_update_user_password` (admin-set reset, confirm-guarded), `scaleway_iam_update_user_username` (confirm-guarded)
- `scaleway_iam_delete_user_mfa_otp` (confirm-guarded, security-weakening), `scaleway_iam_list_user_grace_periods`

**IAM Groups** (issue #5; completes the `group_id` principal loop policy tools already accept - fully live-verified, zero blast radius)
- `scaleway_iam_list_groups` (name is EXACT match, not substring), `scaleway_iam_get_group`
- `scaleway_iam_create_group` (no confirm - reversible, no side effects to anyone), `scaleway_iam_update_group` (name/description/tags)
- `scaleway_iam_delete_group` (confirm-guarded; refuses managed/special/`deletable=false` groups tool-side)
- `scaleway_iam_add_group_member` (one user and/or one application), `scaleway_iam_add_group_members` (bulk, additive) — both refuse managed/special/`editable=false` groups
- `scaleway_iam_set_group_members` (confirm-guarded; FULL-REPLACE - omitted members are removed), `scaleway_iam_remove_group_member` (confirm-guarded) — same special/non-editable refusal

**IAM SSH Keys** (issue #6; `projects`-scope permission, unlike this server's other IAM tools - see gotchas)
- `scaleway_iam_list_ssh_keys`, `scaleway_iam_get_ssh_key`, `scaleway_iam_create_ssh_key` (public keys only - rejects anything that looks like a private key), `scaleway_iam_update_ssh_key` (rename only), `scaleway_iam_delete_ssh_key` (confirm-guarded)

**IAM JWTs** (issue #6; browser/console session tokens, not API keys)
- `scaleway_iam_list_jwts`, `scaleway_iam_get_jwt`, `scaleway_iam_delete_jwt` (confirm-guarded) - `list` structurally 403s for an Application/API-key credential regardless of permissions (see gotchas); implemented per the corrected `/jwts` path in case `get`/`delete` fare better.

**IAM SAML SSO** (issue #6; org-wide - see gotchas for a live incident this was found from)
- `scaleway_iam_get_saml_config`, `scaleway_iam_enable_saml` / `update_saml` / `disable_saml` (all confirm-guarded, org-wide blast radius), `scaleway_iam_list/add/get/delete_saml_certificate` (add/get/delete confirm-guarded where destructive; single-certificate path unverified, see gotchas)

**IAM SCIM provisioning** (issue #6; same org-wide caution as SAML)
- `scaleway_iam_get_scim_config`, `scaleway_iam_enable_scim` / `disable_scim` (confirm-guarded), `scaleway_iam_list/create/delete_scim_token` (create/delete confirm-guarded; token secret returned once, like an API key)

**IAM Security Settings** (issue #6; org-wide auth policy - live-verified both directions)
- `scaleway_iam_get_security_settings`, `scaleway_iam_update_security_settings` (confirm-guarded; only passed fields change)

**IAM Permission sets**
- `scaleway_iam_list_permission_sets` - call this before creating/attaching a policy; see `docs/gotchas.md`.

**Object Storage Buckets** (S3-compatible endpoint, separate auth path from the IAM API)
- `scaleway_s3_create_bucket`, `scaleway_s3_list_buckets`, `scaleway_s3_delete_bucket` - bucket lifecycle.

**Object Storage bucket configuration** (issue #7; behavior facts live-verified 2026-08-18, see `docs/gotchas.md`)
- Tags: `scaleway_s3_get/put/delete_bucket_tagging` (put = full-replace).
- CORS: `scaleway_s3_get/put/delete_bucket_cors` (put = full-replace).
- Versioning: `scaleway_s3_get_bucket_versioning`, `scaleway_s3_set_bucket_versioning` (suspend needs confirm).
- Website: `scaleway_s3_get/put/delete_bucket_website` (put publishes an endpoint, needs confirm).
- Visibility: `scaleway_s3_get/set_bucket_visibility` - coarse public/private via canned ACL (public needs confirm; Bucket Policies are the fine-grained mechanism).
- Lifecycle rules: `scaleway_s3_get/put/delete_bucket_lifecycle` (put/delete confirm-guarded - expiration rules permanently delete objects).
- Encryption config: `scaleway_s3_get/put/delete_bucket_encryption` - real, toggleable setting (console-confirmed), not inert metadata; see `docs/gotchas.md`.
- Object Lock: `scaleway_s3_get_object_lock`, `scaleway_s3_enable_object_lock` (one-way: never disableable, versioning prerequisite handled, versioning frozen afterwards; create-time lock flag is silently ignored by Scaleway).
- No tools for bucket logging or bucket metrics: Scaleway's S3 endpoint returns `NotImplemented` for both.

**Object Storage Bucket Policies**
- `scaleway_s3_get_bucket_policy`, `scaleway_s3_put_bucket_policy`, `scaleway_s3_delete_bucket_policy`

**Object Storage Objects** (single-part only; multipart/large-file upload is out of scope)
- `scaleway_s3_put_object`, `scaleway_s3_get_object`, `scaleway_s3_list_objects`, `scaleway_s3_head_object`, `scaleway_s3_copy_object`, `scaleway_s3_delete_object`, `scaleway_s3_delete_objects`
- `put_object`/`get_object` carry binary payloads as base64 (`encoding: "base64"`); decoded size is capped by `MAX_PUT_OBJECT_BYTES` / `MAX_GET_OBJECT_BYTES` respectively (default 5 MB). `get_object` auto-detects UTF-8 text vs. binary and returns `encoding` accordingly; objects over the get ceiling fail fast - use `scaleway_s3_generate_presigned_url`.
- `scaleway_s3_get_object_tags`, `scaleway_s3_put_object_tags` (`put` replaces the whole tag set, same replace-not-merge semantics as `put_bucket_policy`)
- `scaleway_s3_generate_presigned_url` - time-limited GET/PUT URL for handing direct object access to something outside MCP, without exposing this server's credential.

**Audit Trail — event queries** (read-only; all need `AuditTrailReadOnly` on this server's credential - grant via `scaleway_iam_set_policy_rules`)
- `scaleway_audit_list_events` - who did what, when, from where (API/resource activity).
- `scaleway_audit_list_authentication_events` - authentication activity (login/token/MFA outcomes) - separate endpoint.
- `scaleway_audit_list_system_events` - actions performed by Scaleway's own systems on your resources.
- `scaleway_audit_list_combined_events` - all three streams in one chronological feed, each event tagged api/auth/system.
- `scaleway_audit_get_last_events_overview` - the recent-events snapshot the console's Audit Trail landing page shows.
- `scaleway_audit_list_products` - products/services/methods integrated with Audit Trail (the valid filter-value catalog).

**Audit Trail — alert rules**
- `scaleway_audit_list_alert_rules`, `scaleway_audit_set_alert_rules_enabled` (additive), `scaleway_audit_replace_enabled_alert_rules` (full-replace, confirm-guarded) - Scaleway's preconfigured rules; they can only be enabled/disabled, never created or deleted. Unknown rule IDs reject the whole request atomically (live-verified 2026-08-18).
- `scaleway_audit_list_custom_alert_rules`, `scaleway_audit_create_custom_alert_rule`, `scaleway_audit_update_custom_alert_rule` (name/description only), `scaleway_audit_delete_custom_alert_rule`, `scaleway_audit_set_custom_alert_rules_enabled`, `scaleway_audit_replace_enabled_custom_alert_rules` - **caveat: Scaleway documents these endpoints but the deployed API returns HTTP 501 for every custom-alert-rules method (live-verified 2026-08-18)**. The tools are in place and surface that error verbatim; they'll work when Scaleway ships the backend.

**Audit Trail — export jobs** (ship audit events to an Object Storage bucket)
- `scaleway_audit_list_export_jobs`, `scaleway_audit_create_export_job`, `scaleway_audit_delete_export_job` (confirm-guarded; stops future exports, doesn't delete already-exported objects).
- Alert/export write tools need more than `AuditTrailReadOnly` on this server's credential; permission errors surface verbatim.

## Scope

Deliberately narrow: IAM identity/policy management (Applications, human Users, and Groups),
SSH Keys, JWTs, SAML/SCIM/Security Settings, Bucket Policies, bucket lifecycle and
configuration, Object Storage object CRUD (put/get/list/head/copy/delete/tags/presigned URLs,
single-part only), and Audit Trail (event queries, alert rules, export jobs), because that's what
actually caused friction so far. Not a general Scaleway API wrapper - no compute, databases,
containers, no multipart upload, no bucket logging/metrics (Scaleway's S3 API doesn't implement
them), no Quotas (no real endpoint could be found - see docs/gotchas.md). Extend it the same way
if/when those become a recurring need too.

## Dev

```bash
npm run dev     # tsc --watch
node scripts/smoke-test.mjs   # exercises real tool calls against the live account via .env - not automated CI
```
