# scaleway-ops-mcp-server

[![CI](https://github.com/logic-arts-official/scaleway-ops-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/logic-arts-official/scaleway-ops-mcp-server/actions/workflows/ci.yml)

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

**The credential this server runs as needs its own IAM Policy** granting (at minimum)
`IAMApplicationManager` + `IAMPolicyManager` (organization scope) and `ObjectStorageFullAccess`
(project scope) - see `docs/gotchas.md` for why these must be two separate policy rules. The
`scaleway-ops-mcp` Application (provisioned 2026-08-12) already has this; reuse its credential
rather than minting a new one unless you specifically want a differently-scoped identity.

## Running

Via Claude Code / any MCP client, as a stdio server:

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

**IAM Permission sets**
- `scaleway_iam_list_permission_sets` - call this before creating/attaching a policy; see `docs/gotchas.md`.

**Object Storage Buckets** (S3-compatible endpoint, separate auth path from the IAM API)
- `scaleway_s3_create_bucket`, `scaleway_s3_list_buckets`, `scaleway_s3_delete_bucket` - lifecycle only, deliberately minimal (no visibility/encryption/versioning/lifecycle-rules/website config - use the console or `scw` CLI for those). Exists because Bucket Policies need a bucket to attach to.

**Object Storage Bucket Policies**
- `scaleway_s3_get_bucket_policy`, `scaleway_s3_put_bucket_policy`, `scaleway_s3_delete_bucket_policy`

**Audit Trail**
- `scaleway_audit_list_events` - who did what, when, from where. Needs `AuditTrailReadOnly` on this server's own credential (organization scope, same rule as `IAMApplicationManager`/`IAMPolicyManager` if already present) - grant via `scaleway_iam_set_policy_rules`.

## Scope

Deliberately narrow: IAM identity/policy management, Bucket Policies (plus minimal bucket
create/list/delete, since a policy needs a bucket to attach to), and read-only Audit Trail, because
that's what actually caused friction so far. Not a general Scaleway API wrapper - no compute,
databases, containers, no bucket visibility/encryption/versioning/lifecycle-rules/website config,
etc. Extend it the same way if/when those become a recurring need too.

## Dev

```bash
npm run dev     # tsc --watch
node scripts/smoke-test.mjs   # exercises real tool calls against the live account via .env - not automated CI
```
