# scaleway-ops-mcp-server

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
- `scaleway_iam_create_application`, `scaleway_iam_list_applications`, `scaleway_iam_get_application`, `scaleway_iam_delete_application`

**IAM API keys**
- `scaleway_iam_create_api_key`, `scaleway_iam_list_api_keys`, `scaleway_iam_delete_api_key`

**IAM Policies**
- `scaleway_iam_create_policy`, `scaleway_iam_list_policies`, `scaleway_iam_get_policy`, `scaleway_iam_delete_policy`
- No `update_policy`: Scaleway's PATCH schema for rule changes isn't verified here yet - use delete + recreate.

**IAM Permission sets**
- `scaleway_iam_list_permission_sets` - call this before creating/attaching a policy; see `docs/gotchas.md`.

**Object Storage Bucket Policies** (S3-compatible endpoint, separate auth path from the IAM API)
- `scaleway_s3_get_bucket_policy`, `scaleway_s3_put_bucket_policy`, `scaleway_s3_delete_bucket_policy`

## Scope

Deliberately narrow: IAM identity/policy management + Bucket Policies, because that's what
actually caused friction so far. Not a general Scaleway API wrapper - no compute, databases,
containers, etc. Extend it the same way if/when those become a recurring need too.

## Dev

```bash
npm run dev     # tsc --watch
node scripts/smoke-test.mjs   # exercises real tool calls against the live account via .env - not automated CI
```
