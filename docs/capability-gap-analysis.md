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
| Policies: **clone/duplicate** | ✅ (UI action) | ✅ | ✅ **fixed 2026-08-18** (`scaleway_iam_clone_policy`) - atomic copy of rules/principal/tags; name is duplicated so rename after if needed - tracked in [#3](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/3) |
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
| Bucket visibility (public/private) | ✅ | ✅ (ACL) | ✅ **fixed 2026-08-18** (`scaleway_s3_get/set_bucket_visibility`, public confirm-guarded) |
| Bucket encryption (SSE) | ✅ | ✅ (declarative only) | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_encryption`) - live-verified: config is declarative S3-API metadata, at-rest encryption is always-on platform-side |
| Bucket versioning | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get_bucket_versioning`, `set_bucket_versioning` with suspend confirm-guard) |
| Object lock + retention mode | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get_object_lock`, `enable_object_lock`) - enable is one-way (disable rejected at XML-schema level), requires versioning (tool handles), freezes versioning; create-time lock flag silently ignored by Scaleway; per-object retention modes are object-level ops → #8 |
| Static website hosting | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_website`, put confirm-guarded) |
| Lifecycle rules (expiration/transition) | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_lifecycle`, put/delete confirm-guarded) |
| Bucket tags | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_tagging`) |
| CORS configuration | (console CLI-only per docs) | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_cors`) |
| Object-level ops (upload/download/delete/list objects, metadata, tags) | ✅ (Files tab) | ✅ | ❌ in scope as of 2026-08-18 direction change - implementation tracked in [#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) |
| Bucket metrics / access logs | ✅ | ❌ (S3 API: `NotImplemented`, live-verified 2026-08-18) | ❌ no tools possible on this API surface - logging/metrics live in Cockpit/console, not the S3 API |

## Audit Trail

| Capability | Console | API | This MCP |
|---|---|---|---|
| List events (time range, resource filter) | ✅ | ✅ | ✅ |
| Authentication events (separate endpoint) | ✅ (implied) | ✅ | ✅ **fixed 2026-08-18** (`scaleway_audit_list_authentication_events`) |
| System events | ❓ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_audit_list_system_events`) |
| Combined events / last-events-overview | ❓ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_audit_list_combined_events`, `scaleway_audit_get_last_events_overview`, plus `scaleway_audit_list_products` for the filter-value catalog) |
| Export jobs (ship audit logs to storage) | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_audit_list/create/delete_export_job`; endpoints verified live, lifecycle not end-to-end exercised to avoid creating real export state) |
| Alert rules + custom alert rules (list/enable/disable/create/update/delete) | ✅ | ✅ / ⚠️ | ⚠️ **partially fixed 2026-08-18**: preconfigured alert rules fully covered (`list`/`set_enabled`/`replace_enabled`, endpoints live-verified); custom alert rules have all 6 tools implemented, but **Scaleway's deployed API returns HTTP 501 "unknown method" for every custom-alert-rules method** (verified live against fr-par on 2026-08-18 for GET/POST/PUT/PATCH) - documented-but-unimplemented on Scaleway's side; tools will work when the backend ships |

All Audit Trail gaps in this table were tracked in [#9](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/9) - addressed 2026-08-18, except the custom-alert-rules half, which is blocked on Scaleway implementing its own documented API.

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
Keys/SAML/SCIM, bucket data-plane and settings) - not a gap so much as a confirmation the README's
stated scope is accurate. Audit Trail's alerting/export machinery, originally listed here as out of
scope, was subsequently implemented (2026-08-18) - see the Audit Trail table above for what works
and what's blocked on Scaleway's own API. Each remaining gap is tracked as its own
GitHub issue (labeled `scaleway`) rather than left implicit:
[#3](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/3) policy clone,
[#4](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/4) Users,
[#5](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/5) Groups,
[#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6) SSH Keys/Quotas/JWTs/SAML/SCIM,
[#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) object-level operations
(now in scope, implementation pending),
[#9](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/9) Audit Trail's broader surface.
[#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) bucket configuration was
implemented 2026-08-18 (see the Object Storage table above - only logging/metrics remain impossible:
Scaleway's S3 API does not implement them).

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
