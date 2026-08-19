# Changelog

All notable changes to this project are documented here.

## Unreleased


- `scaleway_iam_set_policy_rules` now requires `confirm=true` and refuses a full-replace that would drop `IAMPolicyManager`/`IAMApplicationManager` from a policy that currently grants them, so a stale or incomplete rules array cannot permanently lock this credential out of IAM (issue #25).
- `scaleway_s3_generate_presigned_url`: `operation: "put"` now requires `confirm=true` and the tool is no longer annotated `readOnlyHint` - a PUT URL exports a time-limited unauthenticated write capability outside the MCP boundary (issue #26).
- `scaleway_audit_create_export_job` now requires `confirm=true` because creation immediately backfills ~6 days of real audit events into the destination bucket, and `scaleway_audit_delete_export_job` does not remove those objects (#27).

## 0.1.1

Security fix: `access_key` (`scaleway_iam_update_api_key`/`scaleway_iam_delete_api_key`) and `jti`
(`scaleway_iam_get_jwt`/`scaleway_iam_delete_jwt`) were the only ID-shaped fields in the tool set
without a format constraint - every other ID field uses `.uuid()`. Both were interpolated
directly into a request path, and an unexpected value could cause the request this server sends
to land on a different API path than the tool call's own name/description implies. Both fields
now require a strict alphanumeric (`access_key`) / alphanumeric-plus-hyphen (`jti`) format,
matching Scaleway's real key/token id shapes - no behavior change for legitimate values.

## 0.1.0

First release. Covers three Scaleway product areas:

### IAM

- Applications: create/get/list/update/delete
- API keys: create/list/update/delete (update covers description/expiry only, never rotates the secret)
- Policies: create/get/list/update/delete/clone
- Policy rules: list / full-replace set
- Permission sets: list (reference catalog)
- Users (human members): list/get/create/update/delete, lock/unlock, password/username reset, MFA-OTP delete, grace periods
- Groups: CRUD plus membership management (add/remove/set members)
- SSH Keys: list/get/create/update/delete
- JWTs: get/delete (list is inherently inaccessible to an Application/API-key credential - documented, not a bug)
- SAML SSO: config get/enable/update/disable, certificate management
- SCIM provisioning: config get/enable/disable, token management
- Security Settings: org-wide auth policy get/update

### Object Storage

- Bucket lifecycle: create/list/delete
- Bucket configuration: visibility, encryption, versioning, Object Lock, static website hosting, lifecycle rules, tags, CORS
- Bucket Policies: get/put/delete
- Objects: put/get/list/head/copy/delete, tags, presigned URLs (single-part only, 5 MB default cap - no multipart)

### Audit Trail

- Event queries: events, authentication events, system events, combined feed, last-events overview, products catalog
- Alert rules: list/enable/disable preconfigured rules; custom alert rule tools are implemented but blocked on Scaleway's own API (documented endpoints return HTTP 501 in production)
- Export jobs: list/create/delete

See [README.md](README.md) for the full tool list and [docs/gotchas.md](docs/gotchas.md) for
non-obvious API behavior this server exists to paper over.
