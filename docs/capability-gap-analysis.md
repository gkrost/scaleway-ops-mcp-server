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
| **Users** (human members): list/create/delete/update, lock/unlock, MFA, password/username | ✅ | ✅ | ✅ **fixed 2026-08-18** (issue #4: `list/get/create/update/delete_user`, `lock/unlock_user`, `update_user_password/username`, `delete_user_mfa_otp`, `list_user_grace_periods`) - reads live-verified; mutation happy-paths negative-test-only (no disposable mailbox); create/invite semantics unverified (see gotchas) |
| **Groups**: list/create/get/update/delete, add/remove members | ✅ | ✅ | ✅ **fixed 2026-08-18** (issue #5: `scaleway_iam_list/get/create/update/delete_group`, `add_group_member(s)`, `set_group_members`, `remove_group_member`) - full happy-path lifecycle live-verified, zero blast radius (this issue is fully reversible, sends nothing to anyone). Managed-group refusal guard implemented but untested live - this org has no `managed`/`all_users`/`all_applications` groups to test against |
| SSH Keys: list/get/create/update/delete | ✅ | ✅ | ✅ **fixed 2026-08-18** (issue #6: `scaleway_iam_list/get/create/update/delete_ssh_key`) - full CRUD live-verified. Project-scoped (`SSHKeysFullAccess`), not org-scoped like this server's other IAM tools - see gotchas. Client-side rejects anything that looks like a private key |
| Quotas: list/get | ✅ (shown contextually) | ❓ | ❌ **could not locate a real endpoint** (issue #6) - the issue's own claimed `/quotas` path 404s, as do 10+ other guesses across IAM/Account APIs and versions. No tool written; deferred with full probe evidence in gotchas.md rather than shipping a speculative dead endpoint |
| JWTs: list/get/delete | ❌ (not really a console feature) | ✅ | ⚠️ **partially fixed 2026-08-18** (issue #6: `scaleway_iam_list/get/delete_jwt`) - real path is `/jwts` (plural) with `audience_id`, corrected from the issue's `/jwt` spec; `list` structurally 403s for this Application/API-key credential regardless of permissions (resource `self_jwt` - likely session-only), documented and left as a surfaced-error path, not a bug |
| IAM Logs (resource-lifecycle log, distinct from Audit Trail) | ✅ (Logs tab) | ✅ | ❌ not covered - likely redundant with `scaleway_audit_list_events` for this server's purposes, but worth knowing it's a separate endpoint |
| SAML (org-wide SSO) | ✅ | ✅ | ✅ **fixed 2026-08-18** (issue #6: `scaleway_iam_get/enable/update/disable_saml`, `list/add/get/delete_saml_certificate`) - real path is org-nested (`/organizations/{id}/saml`), corrected from the issue's flat `/saml` spec; disable is a separate top-level `DELETE /saml/{id}` route. GET live-verified (not-configured state); mutations guard-tested only - **never called live**, see the incident in gotchas.md |
| SCIM (provisioning) | ✅ | ✅ | ✅ **fixed 2026-08-18** (issue #6: `scaleway_iam_get/enable/disable_scim`, `list/create/delete_scim_token`) - same org-nesting correction and same never-called-live caution as SAML, see gotchas.md |
| Security Settings (org-wide auth policy) | ✅ | ✅ | ✅ **fixed 2026-08-18** (issue #6: `scaleway_iam_get/update_security_settings`) - live-verified both directions, including confirming a confirm-only no-op PATCH changes nothing (this one genuinely follows safe "only passed fields change" semantics, unlike SAML/SCIM's enable) |

## Object Storage

| Capability | Console | API | This MCP |
|---|---|---|---|
| Bucket policy: get/put/delete | ✅ | ✅ | ✅ |
| **Bucket lifecycle: create/list/delete buckets** | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_create_bucket`/`list_buckets`/`delete_bucket`) - confirmed missing the hard way during live re-testing: had to script a raw `@aws-sdk/client-s3` call outside this server just to get a bucket to test bucket-policy tools against |
| Bucket visibility (public/private) | ✅ | ✅ (ACL) | ✅ **fixed 2026-08-18** (`scaleway_s3_get/set_bucket_visibility`, public confirm-guarded) |
| Bucket encryption (SSE) | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_encryption`) - see `docs/gotchas.md` for what this config actually controls |
| Bucket versioning | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get_bucket_versioning`, `set_bucket_versioning` with suspend confirm-guard) |
| Object lock + retention mode | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get_object_lock`, `enable_object_lock`) - enable is one-way (disable rejected at XML-schema level), requires versioning (tool handles), freezes versioning; create-time lock flag silently ignored by Scaleway; per-object retention modes are object-level ops (now covered, see below) |
| Static website hosting | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_website`, put confirm-guarded) |
| Lifecycle rules (expiration/transition) | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_lifecycle`, put/delete confirm-guarded) |
| Bucket tags | ✅ | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_tagging`) |
| CORS configuration | (console CLI-only per docs) | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_get/put/delete_bucket_cors`) |
| Object-level ops (upload/download/delete/list objects, metadata, tags) | ✅ (Files tab) | ✅ | ✅ **fixed 2026-08-18** (`scaleway_s3_put_object`/`get_object`/`list_objects`/`head_object`/`copy_object`/`delete_object`/`delete_objects`/`get_object_tags`/`put_object_tags`/`generate_presigned_url`) - full CRUD, live-verified via MCP only (create bucket → put text+binary → head → list → get byte-identical round-trip → tags → copy → presigned-URL fetch → batch delete → delete → bucket gone), see [#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) |
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

Object-level operations, originally listed here as out of scope ("this server never touches object
data"), were also implemented 2026-08-18 - direction changed in
[#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) once the same
friction that motivated the bucket-lifecycle tools (dropping out of MCP to a raw
`@aws-sdk/client-s3` script) turned out to apply to object data too. Presigned URLs and object tags
(originally P1/"implement or defer with rationale") were both implemented rather than deferred - the
extra surface area was small given `s3Client.ts`'s existing SigV4 path, and both are exercised by
`scripts/smoke-test.mjs`.

SSH Keys, JWTs, SAML, SCIM, and Security Settings (formerly listed here as out of scope) were
implemented 2026-08-18 in [#6](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6)
(see the IAM table above) - the one item from that issue NOT implemented is Quotas, deferred because
no real API endpoint could be found despite extensive probing (see gotchas.md). Users (formerly here)
was implemented 2026-08-18 (see the IAM table above), as were Audit Trail's alerting/export machinery,
bucket configuration, and Groups ([#5](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/5),
completing the `group_id` principal loop policy tools already accepted) - see those tables for what
works and what's blocked on Scaleway's own API. IAM has no remaining deliberate scope boundaries as
of this writing - every item originally listed as out of scope has since been implemented. Each
remaining gap elsewhere is tracked as its own GitHub issue (labeled `scaleway`) rather than left
implicit:
[#3](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/3) policy clone,
[#4](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/4) Users,
[#9](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/9) Audit Trail's broader surface.
[#7](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/7) bucket configuration and
[#8](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/8) object-level operations
were both implemented 2026-08-18 (see the Object Storage table above - only logging/metrics remain
impossible: Scaleway's S3 API does not implement them).

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
