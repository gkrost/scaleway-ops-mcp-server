# Capability gap analysis: Console UI vs. Scaleway API vs. this MCP server (2026-08-18)

Method: catalogued this server's actual tool set from `src/tools/*.ts`, the full IAM/Audit Trail API
surface via Scaleway's API reference, and the console UI live (authenticated, read-only navigation
of IAM Users/Groups/Applications/API keys/Policies and one bucket's Settings tabs). Object Storage's
bucket-level API reference page didn't return usable content via fetch, so that section leans on the
console UI (which maps close to 1:1 onto the S3-compatible bucket-level API) plus general S3-API
knowledge - flagged inline where confidence is lower.

**Reminder of this server's stated scope** (from `README.md`): "Deliberately narrow: IAM
identity/policy management, Bucket Policies, and read-only Audit Trail... Not a general Scaleway API
wrapper." Most of what follows is *out of scope by design*, not an oversight - it's listed so the
scope boundary is a deliberate, visible line rather than an implicit one.

## IAM

| Capability | Console | API | This MCP |
|---|---|---|---|
| Applications: create/get/list/update/delete | ✅ | ✅ | ✅ |
| API keys: create/list/delete | ✅ | ✅ | ✅ |
| **API keys: update** (description/expiry without rotating the secret) | ✅ | ✅ (`UPDATE`) | ✅ **fixed 2026-08-18** (`scaleway_iam_update_api_key`) |
| Policies: create/get/list/update/delete | ✅ | ✅ | ✅ |
| Policies: **clone/duplicate** | ✅ (UI action) | ✅ | ❌ missing (achievable manually: `get` + re-`create`) - tracked in [#3](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/3) |
| Policy rules: list/set (full-replace) | ✅ | ✅ | ✅ |
| Permission sets: list | ✅ | ✅ | ✅ |
| **Users** (human members): list/create/delete/update, lock/unlock, MFA, password/username | ✅ | ✅ | ❌ out of scope (this server manages Applications, i.e. non-human identities, only) - tracked in [#4](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/4) |
| **Groups**: list/create/get/update/delete, add/remove members | ✅ | ✅ | ❌ out of scope (`create_policy`/`set_policy_rules` accept a `group_id` principal, but nothing here creates or manages the group itself) - tracked in [#5](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/5) |
| SSH Keys | ✅ | ✅ | ❌ out of scope (unrelated to this server's IAM/storage focus) - tracked in [#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6) |
| Quotas: list/get | ✅ (shown contextually) | ✅ | ❌ out of scope, low value here - tracked in [#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6) |
| JWTs: list/get/delete | ❌ (not really a console feature) | ✅ | ❌ out of scope, niche - tracked in [#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6) |
| IAM Logs (resource-lifecycle log, distinct from Audit Trail) | ✅ (Logs tab) | ✅ | ❌ not covered - likely redundant with `scaleway_audit_list_events` for this server's purposes, but worth knowing it's a separate endpoint |
| SAML / SCIM / Security Settings (org-wide SSO, provisioning, auth policy) | ✅ | ✅ | ❌ out of scope - enterprise SSO/provisioning, unrelated to this server's credential-provisioning use case - tracked in [#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6) |

## Object Storage

| Capability | Console | API | This MCP |
|---|---|---|---|
| Bucket policy: get/put/delete | ✅ | ✅ | ✅ |
| **Bucket lifecycle: create/list/delete buckets** | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_create_bucket`/`list_buckets`/`delete_bucket`) - confirmed missing the hard way during live re-testing: had to script a raw `@aws-sdk/client-s3` call outside this server just to get a bucket to test bucket-policy tools against |
| Bucket visibility (public/private) | ✅ | ✅ (ACL) | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Bucket encryption (SSE) | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Bucket versioning | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Object lock + retention mode | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Static website hosting | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Lifecycle rules (expiration/transition) | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Bucket tags | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| CORS configuration | (console CLI-only per docs) | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |
| Object-level ops (upload/download/delete/list objects, metadata, tags) | ✅ (Files tab) | ✅ | ❌ out of scope - this server is policy/access-control only, never touches object data - tracked in [#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) |
| Bucket metrics / access logs | ✅ | ✅ | ❌ out of scope - tracked in [#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) |

## Audit Trail

| Capability | Console | API | This MCP |
|---|---|---|---|
| List events (time range, resource filter) | ✅ | ✅ | ✅ |
| Authentication events (separate endpoint) | ✅ (implied) | ✅ | ❌ not covered |
| System events | ❓ | ✅ | ❌ not covered |
| Combined events / last-events-overview | ❓ | ✅ | ❌ not covered |
| Export jobs (ship audit logs to storage) | ✅ | ✅ | ❌ not covered |
| Alert rules + custom alert rules (list/enable/disable/create/update/delete) | ✅ | ✅ | ❌ not covered - this is the one gap in this section with real standalone value (alerting, not just querying), worth a look if Audit Trail becomes a bigger focus |

All Audit Trail gaps in this table are tracked together in [#9](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/9).

## Bottom line

Two items were worth actually fixing regardless of the "deliberately narrow" scope, because they're
small, sit squarely inside IAM/Bucket-Policy (not a scope expansion), and were felt directly during
this session's live re-test - **both fixed and live-verified 2026-08-18**:

1. **`scaleway_iam_update_api_key`** - the API supports it; the only alternative was
   delete-and-recreate, which rotates the secret and breaks anything using it, disproportionate for a
   metadata-only change. Added, and confirmed live that it changes `description` without changing
   `access_key`.
2. **`scaleway_s3_create_bucket`/`list_buckets`/`delete_bucket`** - minimal lifecycle only (no
   ACL/versioning/lifecycle - those remain genuinely out of scope), closing the gap that forced this
   session's live re-test to drop out of the MCP entirely (a raw SDK script) just to get a bucket to
   test the bucket-policy tools against. Confirmed live: create → appears in list → delete → gone
   from list.

Everything else in the tables above is a legitimate, deliberate scope boundary (Users/Groups/SSH
Keys/SAML/SCIM, bucket data-plane and settings, Audit Trail's alerting/export machinery) - not a gap
so much as a confirmation the README's stated scope is accurate. Each is now tracked as its own
GitHub issue (labeled `scaleway`) rather than left implicit:
[#3](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/3) policy clone,
[#4](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/4) Users,
[#5](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/5) Groups,
[#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6) SSH Keys/Quotas/JWTs/SAML/SCIM,
[#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) bucket configuration,
[#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) object-level operations,
[#9](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/9) Audit Trail's broader surface.

## Is this server redundant with something official/established? (checked 2026-08-18)

Before investing further, checked whether Scaleway itself or a well-established community project
already covers this ground:

- **`scaleway/scaleway-skills`** (the only MCP-related repo in the official `scaleway` GitHub org,
  Apache-2.0, 4 stars, 2 commits) is a thin skills/config layer around the `scw` CLI - not an
  API-wrapping MCP server, no mention of IAM, Bucket Policies, or Audit Trail.
- No `@scaleway/*` npm package or blog post announces an official IAM/ops MCP server.
- The most comprehensive **community** project, `sndpl/scaleway-mcp` (155+ tools across 21
  products, 0 stars, explicitly beta/unofficial), bundles IAM only generically - no visible
  policy-rule granularity, and no Bucket Policy or Audit Trail tools found in its README. Two other
  unofficial servers found are scoped to unrelated products (Serverless Functions) or unverified in
  this specific area.

**Verdict: not redundant.** Nothing official or well-established covers IAM Policy/Rules + Bucket
Policy + Audit Trail specifically - this server's narrow scope is still a real, unaddressed gap, not
a duplicate of existing tooling. No reason to shelve it on that basis.
