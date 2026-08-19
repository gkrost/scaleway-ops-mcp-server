# Scaleway API gotchas this server exists to paper over

All found empirically, 2026-08-12, provisioning a least-privilege backup credential for
an unrelated project before this server existed - documented here so the next thing that hits them
doesn't have to rediscover them by trial and error.

## A Bucket Policy alone does not grant access

Scaleway needs **two** separate grants on a credential's Application, or every S3 call fails
`AccessDenied` - a generic code covering both "bad signature" and "not authorized," so a live call
is the only way to tell which:

1. An **IAM Policy** (`scaleway_iam_create_policy`) attached to the Application, scoped to the
   Project, granting at least `ObjectStorageReadOnly` + `ObjectStorageObjectsWrite`. Without this,
   even `ListBucket`/`HeadBucket` fail - `ObjectStorageBucketsRead` alone does **not** cover them.
2. A **Bucket Policy** (`scaleway_s3_put_bucket_policy`) on the specific bucket, naming that
   `application_id` and the exact actions/resources.

The IAM Policy is the broad, Project-wide half (grants access to *every* bucket in the Project);
the Bucket Policy narrows it to one bucket. Both are required together.

## Permission sets have a `scope_type`, and it's not optional

`POST /iam/v1alpha1/policies` rejects a rule that mixes permission sets of differing `scope_type`
(`organization` vs `projects`) with `"permission sets must be of the same scope type"`. Put them in
separate `rules[]` entries instead - one rule per scope_type, each with its own `organization_id`
or `project_ids`. Call `scaleway_iam_list_permission_sets` to check a name's `scope_type` before
building a rule around it.

## `s3:HeadObject` is not a valid bucket-policy action

Unlike some AWS documentation you might expect this from, Scaleway's bucket-policy engine doesn't
recognize `s3:HeadObject` - submitting it fails validation with `"Policy has invalid action"`.
`HeadObject`/`HeadBucket` calls are authorized via `s3:GetObject`/`s3:ListBucket` respectively,
matching AWS's own actual IAM semantics (AWS doesn't have a separate `HeadObject` action either).

## Bucket-policy `Resource` entries are bare bucket names, not ARNs - and `application_id` Principals need `Version: "2023-04-17"`

Confirmed empirically 2026-08-18, live-retesting every tool: despite the AWS-compatible S3 API/SDK
everywhere else in this server, a bucket policy's `Resource` array must be bare names
(`"my-bucket"`, `"my-bucket/*"`), **not** ARNs. `"arn:aws:s3:::my-bucket"` and
`"arn:scw:s3:::my-bucket"` both fail with `"Policy has invalid resource"` - there is no ARN prefix
at all for this field. Separately, an `application_id` `Principal` (`{"SCW":"application_id:<uuid>"}`)
requires `"Version": "2023-04-17"` in the document; the AWS-standard `"2012-10-17"` fails with
`"application_id Principal is supported in the bucket-policy versions 2023-04-17"` before the
`Resource` field is even validated. Working example:

```json
{
  "Version": "2023-04-17",
  "Statement": [
    {
      "Sid": "Example",
      "Effect": "Allow",
      "Principal": { "SCW": "application_id:<uuid>" },
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": ["my-bucket", "my-bucket/*"]
    }
  ]
}
```

## Tags reject `:` as a separator

`PATCH .../applications/{id}` and `PATCH .../policies/{id}` validate each tag against
`^[a-zA-Z0-9._\-/=+@ ]+$` - a colon-separated tag like `"env:prod"` fails with
`"tags[0]: value does not match regex pattern..."`. Confirmed empirically 2026-08-18. Use `=`
instead (`"env=prod"`), which this server's own tool descriptions now recommend.

## `GET /iam/v1alpha1/policies?application_id=X` silently ignores the filter

Confirmed by direct comparison: the same query with and without `application_id` returned the
identical full org-wide list (`total_count` unchanged either way). `scaleway_iam_list_policies`
in this server fetches everything and filters client-side rather than trusting the query param.
`GET /iam/v1alpha1/api-keys?application_id=X` does **not** have this problem - it filters
correctly server-side.

## List endpoints paginate past 100, and filters must run after fetching every page

`GET /iam/v1alpha1/permission-sets` returns ~174 entries; a `page_size=100` single-page fetch
followed by a client-side `name_filter` for `"ObjectStorage"` returned **zero** matches, because
the results are alphabetically ordered and every `ObjectStorage*` entry falls on page 2. Every
`list_*` tool in this server fetches all pages (`iamListAll` in `src/iamClient.ts`) before
applying any filter.

## API-key creation: the secret is shown exactly once

Standard Scaleway behavior, but worth restating: `secret_key` is present in the
`scaleway_iam_create_api_key` response and in no other response, ever. There is no recovery
endpoint - only revoke (`scaleway_iam_delete_api_key`) and mint a replacement.

## `name` is capped at 64 chars, `description` at 200 - not the looser limits this server first used

Found while adding `update_application`/`update_policy` (2026-08-12): the create tools' Zod schemas
originally allowed `name` up to 200 chars and `description` up to 1000, both looser than what
Scaleway's own API docs state (`name` max 64, `description` max 200 on both Applications and
Policies). A too-long value would have passed client-side validation and failed server-side
instead, later and less clearly. Fixed in both `applications.ts` and `policies.ts`.

## `PATCH .../applications/{id}` and `PATCH .../policies/{id}` replace `tags`, they don't merge it

Same replace-not-merge semantics as `scaleway_s3_put_bucket_policy`, confirmed via Scaleway's docs
rather than assumed from REST convention alone (PATCH *can* mean partial-merge-per-field on some
APIs; here it means "each field you include is fully replaced, each field you omit is left alone" -
so omitting `tags` entirely leaves it untouched, but passing `tags: ["a"]` on a resource that
already carries `["a","b"]` drops `b`). `update_application`/`update_policy` pass through only the
fields the caller supplies for exactly this reason - callers must send the complete desired tag set.

## Renaming an Application or Policy is always safe - nothing references either by name

Verified before building `update_application`/`update_policy`: Bucket Policies name a principal by
`application_id` (a UUID), API keys belong to an `application_id`, and the credential pair
(access/secret key) is entirely independent of the `name` field. Changing `name`/`description`/
`tags` cannot break a live credential or require touching anything downstream - confirmed, not
assumed, before this was relied on to justify a same-day rename pass across the account.

## `GET /policies/{id}` never returns `rules`, despite `create` accepting them

Confirmed empirically 2026-08-12: a Policy's rules are not part of the Policy object Scaleway
returns from `GET`/`LIST` - `nb_rules` is a count, not the array. Rules live at their own
top-level resource - see the next entry for the exact (corrected) path.
`scaleway_iam_get_policy`'s tool description used to imply otherwise and has been corrected.

## Rules live at `/iam/v1alpha1/rules`, NOT `/policies/{id}/rules` - and this was documented wrong for a few hours

`scaleway_iam_list_policy_rules`/`scaleway_iam_set_policy_rules` originally called
`GET`/`PUT /policies/{id}/rules`, based on a WebFetch-summarized read of Scaleway's OpenAPI schema
that turned out to be **wrong** - that path 404s. Caught only by testing live against the account
during an unrelated audit, not by the doc research that produced it. The real shape, confirmed by
direct `curl`:

- **List:** `GET /iam/v1alpha1/rules?policy_id={id}` -> `{"rules":[...], "total_count":N}`
- **Set (full replace):** `PUT /iam/v1alpha1/rules` with body `{"policy_id":"...", "rules":[...]}`
  -> `{"rules":[...]}`. `POST /iam/v1alpha1/rules` (create one rule standalone) is **not**
  supported - `405 Method Not Allowed` - so adding a single permission set still means: list the
  current rules, add/edit the one you need client-side, `PUT` the whole array back. Same
  replace-not-merge semantics as `tags` and Bucket Policies below - always submit the full array.

**Lesson, not just a fix:** a summarized read of a large OpenAPI YAML (via WebFetch's small-model
pass) produced a plausible, confidently-stated, *wrong* path, and it sat in this file as if
verified for a few hours before a live call caught it. Treat any endpoint path from a summarized
doc fetch as a hypothesis until it's actually been called, not as confirmed - especially before
building a tool around it.

This is still the right tool for changing what a *live* policy grants, and strictly safer than
deleting and recreating the policy object itself: if a policy grants its own holder
`IAMPolicyManager` (as `scaleway-ops-mcp`'s does), deleting it revokes that permission the instant
the delete succeeds, before a replacement can be created - the very next `create_policy` call would
itself fail `permissions_denied`, since the credential attempting it no longer holds the permission
that call requires. `SetRules` has no such window: the policy object, and everything that already
depends on its `id`, never stops existing.

### Distinct lockout: a successful full-replace that omits the IAM-management rule

`set_policy_rules` has a second lockout mode of its own. The PUT is a complete replace, not a
merge: if the caller reconstructs `rules` from a stale or incomplete `list_policy_rules` read and
omits the rule granting `IAMPolicyManager`/`IAMApplicationManager`, the call used to succeed
immediately - and whoever that policy granted IAM management to (including this server) was then
permanently unable to call `set_policy_rules` or any other IAM policy/application tool to undo it.
The tool now requires `confirm=true`, and the handler GETs the current rules first and refuses a
replace that would drop `IAMPolicyManager` or `IAMApplicationManager` from a policy that currently
has them. Policies that never carried those permission sets are unaffected. `delete_policy` now
refuses the same class of lockout even with `confirm=true`.

### `delete_policy`'s own guard does not cover deleting the policy's principal instead

`delete_policy` and `set_policy_rules` both refuse to touch a policy that currently grants
`IAMPolicyManager`/`IAMApplicationManager` - but neither is the only way to strip that grant.
`delete_application`'s own description already says it "detaches every policy scoped to it" -
DETACHES, not deletes - and `delete_group` documents the identical consequence for a Policy naming
that group's `group_id`. Deleting the Application/Group that holds an IAM-management policy
orphans that policy (its `application_id`/`group_id` goes back to unset) without ever calling
`delete_policy` or `set_policy_rules`, so neither guard fires - the exact same lockout, reached
through the principal instead of the policy. Both `delete_application` and `delete_group` now list
the org's policies, filter to ones attached to that principal, and refuse (even with `confirm=true`)
if any of them grant IAM management - same `grantsIamManagement` check `delete_policy` uses,
shared via `findIamManagementPoliciesFor` in `policies.ts`. `delete_user` is not covered: a User is
never this server's own principal (that's always an Application), and the existing owner-account
refusal already blocks the one clearly catastrophic case.

## `POST /policies/{id}/clone` ignores its request body and always returns the clone unattached

Confirmed empirically 2026-08-18, reviewing `scaleway_iam_clone_policy`: the clone endpoint copies
rules correctly but silently drops the principal and tags regardless of what's passed - the clone
always comes back `no_principal: true` with `tags: []`, even when the request body explicitly
includes `application_id`/`user_id`/`group_id`/`name` overrides (all silently ignored; the name gets
Scaleway's own `"Copy of <source name>"` default, not an override). Worse than just a doc gap: since
`scaleway_iam_update_policy` only patches `name`/`description`/`tags` (never a principal field),
there was briefly no way to reattach a clone's principal through this server at all. Confirmed via a
direct `PATCH /policies/{id}` call that Scaleway's API *does* accept and apply `application_id` -
it's this server's tool schema that didn't expose it, not an API limitation. `clone_policy` now
follows its `POST .../clone` with a `PATCH` restoring the source's principal and tags before
returning, so the tool actually delivers an exact copy instead of an orphaned one.

## `nb_rules`/`nb_permission_sets` can read 0 immediately after `create_policy` or `clone_policy`, even though the rules did apply

Confirmed empirically 2026-08-18, live-retesting: the `Policy` object returned directly by
`POST /policies` (and by extension `POST /policies/{id}/clone`) can report `nb_rules: 0` in that same
response even though the rules were in fact created - a follow-up `scaleway_iam_get_policy` or
`scaleway_iam_list_policy_rules` on the same policy immediately afterward shows the correct count and
the actual rules. Looks like the count lags the write by a moment. Not a bug in this server (it
passes Scaleway's response through as-is) - just don't read a `0` in a `create`/`clone` response as
"the rules didn't take"; call `scaleway_iam_list_policy_rules` for ground truth if in doubt.

## Audit Trail needs its own permission set, and it's organization-scoped

`scaleway_audit_list_events` needs `AuditTrailReadOnly` (or `OrganizationManager`) - not implied by
`ObjectStorageFullAccess` or the two IAM permission sets this server was originally provisioned
with. Its `scope_type` is `organization` (confirmed via `scaleway_iam_list_permission_sets`), same
as `IAMApplicationManager`/`IAMPolicyManager` - add it to that same rule via `set_policy_rules`
rather than creating a new rule, no scope-type-mixing concern here.

## Audit Trail pagination is cursor-based, not page-number - and carries no `total_count`

Unlike every IAM list endpoint (`page`/`page_size`, `total_count` in the response),
`GET /audit-trail/v1alpha1/regions/{region}/events` pages via `next_page_token` and never reports
a total. `scaleway_audit_list_events` treats its `max_pages` as a safety cap, not a completeness
guarantee, and says so in the response (`truncated: true` plus the last `next_page_token`) rather
than silently stopping.

## Creating an Audit Trail export job immediately backfills past days, it doesn't just start a future cadence

Live-verified 2026-08-18, test-driving `scaleway_audit_create_export_job` (issue #9 / PR #11):
creating a job against an empty throwaway bucket produced six daily log objects
(`2026/07/12/logs_*.json` through `2026/07/17/logs_*.json`) within seconds - a backfill of the
*past* several days, not just events going forward. `scaleway_audit_delete_export_job` explicitly
does not delete already-exported objects (by design, matching every other delete tool in this
server), so a bucket created purely to test an export job will NOT be empty afterward -
`scaleway_s3_delete_bucket` fails `BucketNotEmpty` until those objects are removed - list them with
`scaleway_s3_list_objects` and delete with `scaleway_s3_delete_objects` (confirm-gated). The tool
now requires `confirm=true`.

## Preconfigured alert rules start all-disabled, and the two write tools differ in blast radius

`scaleway_audit_list_alert_rules` returned all 11 preconfigured rules as `disabled` on a
long-running production Organization (not a fresh account) - nothing is enabled by default.
Live-verified: `scaleway_audit_set_alert_rules_enabled` (additive) and
`scaleway_audit_replace_enabled_alert_rules` (full-replace) both reject an unknown rule ID with a
whole-request `404` and no partial application - confirmed by enabling a real rule alongside a
fabricated UUID and observing the real one stayed untouched. Only the additive tool was exercised
live end-to-end (enable -> verify -> disable -> verify reverted); `replace_enabled_alert_rules`
itself was blocked by Claude Code's own auto-mode safety classifier during this session's test pass
and remains functionally unverified beyond its shared request-validation behavior - worth a
deliberate live check before relying on its "everything not listed gets disabled" semantics.

## Console navigation friction is unrelated to any of the above

Provisioning this same credential manually through the web console (before this server existed)
hit repeated silent click failures on sensitive actions (attaching a policy, generating an API
key) that turned out to be a permission classifier gating those specific actions in that
environment - unrelated to anything about Scaleway's own API or console. Not relevant here since
this server talks to the API directly, but noted in case a future console-automation attempt hits
the same wall.

## Object Lock on Scaleway: create-time flag silently ignored, enable needs versioning, disable is schema-impossible (issue #7)

All live-verified 2026-08-18 against fr-par with throwaway buckets (probe scripts in the PR description):

- `CreateBucket` with `ObjectLockEnabledForBucket: true` is **silently ignored** - returns 200/OK, but `GetObjectLockConfiguration` stays `ObjectLockConfigurationNotFoundError` and versioning stays unset. The console's "Object Lock" create-time checkbox must go through a different (non-S3) path; via the S3 API the only working sequence is enable-versioning -> `PutObjectLockConfiguration`.
- `PutObjectLockConfiguration` on a bucket without versioning fails `InvalidBucketState: Versioning must be 'Enabled'...` - so `scaleway_s3_enable_object_lock` checks/enables versioning itself (`enable_versioning_if_needed`).
- Disabling is impossible at the protocol level: `ObjectLockEnabled: "Disabled"` is rejected `MalformedXML` (the schema has no disabled state) - a true one-way door, documented as such in the tool.
- After lock is enabled, versioning is frozen: `PutBucketVersioning Suspended` fails `InvalidBucketState: An Object Lock configuration is present on this bucket, so the versioning state cannot be changed.`
- An empty bucket with lock + versioning enabled still deletes normally (`DeleteBucket` OK) - no residue trap there.

## S3 bucket encryption config on Scaleway is a real, toggleable setting - an earlier version of this entry claimed otherwise and was wrong (issue #7 / PR #13)

`GetBucketEncryption` on a fresh bucket returns HTTP 200 with an **empty** `ServerSideEncryptionConfiguration` (AWS returns a NotFound error instead) - that part's confirmed. What the PR originally shipped got wrong: it claimed `PutBucketEncryption`/`DeleteBucketEncryption` "change nothing about actual at-rest encryption" and were declarative-only S3-API-compatibility filler. **Live-verified false** during PR #13's review pass, cross-checked against the console (2026-08-18): calling `scaleway_s3_put_bucket_encryption` visibly flips the bucket's Settings tab "Encryption type" from `Disabled` to `SSE-ONE encryption with Scaleway Object Native Encryption keys`, and `scaleway_s3_delete_bucket_encryption` reverts it back to `Disabled` - a real setting, not inert metadata. What exactly "SSE-ONE" changes about ciphertext/key handling at rest isn't independently confirmed here, only that the setting is real and the API calls control it - don't repeat the original claim that this is a no-op. Fixed in the tool descriptions and this entry. **Lesson repeated from the `/policies/{id}/clone` entry above**: a plausible-sounding "this is just metadata" claim, stated confidently from source/API-shape reasoning without an actual console cross-check, shipped wrong into a merged tool description - console/UI verification isn't optional polish for claims like this, it's the only way to catch them.

## S3 bucket logging and bucket metrics are NotImplemented on Scaleway (issue #7)

`PutBucketLogging`/`GetBucketLogging` -> `NotImplemented: Action not implemented`; `GetBucketMetricsConfiguration` -> same. Access logging and metrics on Scaleway live elsewhere (Cockpit / console), not behind the S3 API - no tools exist for them and none are possible on this API surface.

No repeat of that friction during #8's console cross-validation (2026-08-18) - uploading via the
Files tab went through cleanly via browser automation. One console-only step worth knowing about
though: the console's drag-and-drop/file-picker upload always interposes a "Storage class" modal
(Standard Multi-AZ vs. others) before the upload actually starts, even for a single small file -
there's no default-and-skip. `scaleway_s3_put_object` has no such step (S3's `PutObject` doesn't
require a storage class; Scaleway defaults it), so an MCP upload and a console upload of the same
file take genuinely different paths to the same result, not just a UI-vs-API skin over one flow.

## IAM Users: invite-vs-create unresolved, owner is type-flag not boolean, password is admin-set (issue #4)

Live-probed 2026-08-18 (read-only + bogus-id error shapes; no disposable mailbox, so the create happy-path stayed unprobed):

- Scaleway docs say users "can only be invited to join" an Organization, yet `POST /iam/v1alpha1/users` exists and requires a `type` field (missing-type probe: 400 `type: value is required`). Email-format validation fires before type validation, so the valid `type` enum could not be enumerated without sending a real invitation email. `scaleway_iam_create_user` defaults to `type: "guest"` (inferred from the guest-scoped delete endpoint) and labels the semantics unverified in its description.
- The org owner is identified by `type: "owner"` on the user object - there is no `organization_owner` boolean. `delete_user` refuses owner deletion tool-side, and the API's delete endpoint is guest-scoped anyway ("Delete a guest user").
- `update-password` takes an explicit caller-supplied `password` (1-72 bytes - probed: empty body gives the length constraint), i.e. admin-set reset, not a generated-secret response like API-key creation. The tool therefore never returns a password.
- All user mutations return clean `404 resource: user` on bogus ids - surfaced verbatim.
- The server credential needed `IAMUserManager` added to its existing org-scoped IAM rule (granted via this server's own `set_policy_rules`, 2026-08-18) - `GET /users` 403s with only IAMApplicationManager.
- `mfa` on the user object is a plain boolean; MFA OTP enrollment (create/validate) is deliberately not a tool - validation needs the person's authenticator code, and a created-but-unvalidated factor leaves MFA half-configured.

## IAM SSH Keys / JWTs / SAML / SCIM / Security Settings: five wrong paths, one live incident (issue #6)

Live-probed 2026-08-18. The issue's own API-surface table (itself sourced from Scaleway's docs page,
not a live call) turned out wrong for four of six workstreams - re-confirming the standing lesson
from the `/policies/{id}/rules` entry above: treat a doc-sourced path as a hypothesis, not a fact,
until an actual call confirms it.

- **SSH Keys are `projects`-scope, not `organization`-scope**, unlike every other IAM tool in this
  server. `GET /ssh-keys?organization_id=...` 403s; the working call is
  `GET /ssh-keys?project_id=...`, and the permission sets are `SSHKeysReadOnly`/`SSHKeysFullAccess`
  with `scope_type: "projects"` - granted as a **project**-scoped policy rule, not folded into the
  existing org-scoped rule. Live-verified full CRUD (create -> get -> list -> rename -> delete).
- **JWTs live at `/jwts` (plural), not `/jwt`, and take `audience_id` (a user_id), not
  `organization_id`.** Even with the credential's policy extended to full `IAMManager`, `list`/`get`
  still 403 with resource `self_jwt` for every `audience_id` tried (including the org owner's own
  id) - the action name strongly suggests this surface is scoped to a session's OWN JWTs, which an
  Application/API-key credential structurally never has (JWTs are browser/console login tokens; an
  API key doesn't do interactive login). Implemented per the corrected path, left live-unverified
  beyond the 403 - may be permanently inaccessible from this server's auth model regardless of
  permissions. `GET`/`DELETE /jwts/{id}` (singular-item paths) ARE plain, non-`self`-scoped routes
  (confirmed via bogus-id 404 shape), so `get_jwt`/`delete_jwt` may work even though `list_jwts`
  doesn't - untested live, since there was nothing valid to fetch.
- **SAML, SCIM, and Security Settings are org-nested (`/organizations/{id}/saml` etc.), not flat
  (`/saml`).** Security Settings' path otherwise matched the issue spec (`GET`/`PATCH
  .../security-settings`, live-verified both ways - see the incident-avoidance note below). SAML and
  SCIM's own base paths matched once org-nested, but their **disable** endpoint does NOT follow the
  same nesting: `DELETE /organizations/{id}/saml` and `.../scim` both **405 Method Not Allowed** -
  the real disable is a **top-level, resource-id-scoped** `DELETE /saml/{saml_id}` /
  `DELETE /scim/{scim_id}`, confirmed live (see incident below). `scaleway_iam_disable_saml`/
  `disable_scim` therefore GET the config first to resolve its id, then DELETE that top-level path.
  Certificates/tokens sub-resources follow the SAME nested nesting as the parent, confirmed via GET:
  `/saml/{saml_id}/certificates`, `/scim/{scim_id}/tokens` - but the further single-item paths
  (`.../certificates/{certificate_id}`, `.../tokens/{token_id}`) could NOT be confirmed without a
  live SAML/SCIM config to test against (deliberately not recreated - see below), so
  `get_saml_certificate`/`delete_saml_certificate`/`delete_scim_token` follow the same nesting
  convention as a best guess and say so in their tool descriptions.
- **Quotas could not be located anywhere in the public API.** `GET /quotas`, `/quotas/{name}` (the
  issue's own claimed path) 404s. So do 10+ other guesses tried: IAM v1alpha1 and Account API v2 /
  v2alpha1 / v3, organization-scoped and project-scoped, flat and nested, including
  `GET /account/v3/organizations/{id}` (a real, 200-returning route) which does NOT include a
  `quotas` field despite `OrganizationReadOnly`'s own permission-set description explicitly saying
  "Read access to the Organization's general information (e.g. Organization ID and quotas)". No
  `quotas.ts` was written for this issue - deferred with this evidence rather than shipping a
  speculative dead endpoint. If a real path surfaces later (a differently-versioned API, a
  console-only feature with no public endpoint, or something requiring a permission this
  credential still lacks), re-open as its own follow-up.

### Incident: an empty POST body to `/organizations/{id}/saml` and `.../scim` does NOT validation-error - it silently ENABLES the feature live

Every other IAM write endpoint in this API 400s cleanly on a missing required field (see the `users`
section above: "missing-type probe -> 400"). That pattern was relied on here too, to learn SAML/
SCIM's required fields safely with an empty `{}` body - the same technique used throughout this
file. Instead, `POST /organizations/{id}/saml` with `{}` returned **200**, creating a real SAML
config (`status: "missing_certificate"`) on the live Organization, and `POST .../scim` with `{}`
likewise returned **200**, fully enabling SCIM. Filed as a Scaleway bug report:
[issue #6 comment](https://github.com/logic-arts-official/scaleway-ops-mcp-server/issues/6#issuecomment-5329691504).

Neither was immediately exploitable - `login_saml_enabled` on the Organization object never flipped
to `true` (SAML stayed in `missing_certificate`, unable to validate any assertion), and SCIM had no
token yet, so nothing external could provision through it - but it was still an unintended,
unauthorized change to production org-wide auth configuration from what should have been a read-safe
probe. Reverted immediately (`DELETE /saml/{id}`, `DELETE /scim/{id}` - see the disable-path entry
above, discovered *from* fixing this), confirmed via `GET` back to `404 not_found` on both, and
`login_saml_enabled` false throughout.

**Consequence for this server's tools:** `enable_saml`/`update_saml` require `entity_id` and
`single_sign_on_url` as non-optional zod strings specifically so this server can never send a
near-empty body the way the probe accidentally did. `add_saml_certificate`/`create_scim_token`'s
exact field shapes were deliberately never live-tested while building this issue, to avoid a repeat -
their tool descriptions say so explicitly. `enable_scim` is the one exception: it now has *confirmed*
live evidence that the endpoint genuinely takes no fields at all, so its empty-body call is
intentional and confirm-gated, not an accident.

**Consequence for how this file's own established technique gets used going forward:** the
"empty-body probe" pattern is safe *only* when there's independent evidence the target endpoint
validates-then-acts rather than acts-with-defaults - which was true for every prior use in this repo
(IAM Users, Policies, API keys) but is not universal. Before relying on it again, consider whether
the call is expected to be a `create`-shaped action (validates) or an `enable`/`toggle`-shaped one
(may just apply defaults) - the latter deserves either a `GET`-only cross-check first (as was
retroactively used to confirm the disable path here) or explicit user sign-off before attempting on
a live account, same as this issue's own protocol already required for the *known* R3 mutations.

## Unverified SAML/SCIM field shapes and paths (issue #6) - check before first live use

Several SAML/SCIM tools could not be live-verified without re-creating the org-wide SSO/provisioning
state (deliberately avoided after the empty-body enable incident above). These are best-effort
guesses against Scaleway's conventions, each already flagged in its tool description, and may 400
on first real use - listed here in one place:

| Tool | What's unverified |
|---|---|
| `scaleway_iam_add_saml_certificate` | request field name is assumed `certificate` (PEM payload) |
| `scaleway_iam_get_saml_certificate` | single-item path `/saml/{saml_id}/certificates/{id}` (list path is confirmed) |
| `scaleway_iam_delete_saml_certificate` | same single-item path as get |
| `scaleway_iam_create_scim_token` | request field name is assumed `description` |
| `scaleway_iam_delete_scim_token` | single-item path `/scim/{scim_id}/tokens/{id}` (list path is confirmed) |
| `scaleway_iam_update_saml` | HTTP method is `PATCH` per the API reference (distinct from enable's `POST`), never live-verified |

Verify against the live API (with explicit user sign-off, given the blast radius) before any of
these are relied on in production.

## Enabling versioning then deleting objects leaves `delete_bucket` failing `BucketNotEmpty` (found 2026-08-18, full-feature-set test drive)

Repro: `create_bucket` -> `set_bucket_versioning(Enabled)` -> `put_object` + `delete_object` -> `delete_bucket(confirm: true)` fails `BucketNotEmpty`, even though `scaleway_s3_list_objects` shows the bucket as empty. On a versioned bucket, `DeleteObject` creates a delete-marker instead of removing the underlying version - `list_objects` hides anything behind a delete-marker, but the non-current version is still there, so S3 correctly refuses the bucket delete. This server's Object Storage tools have no `ListObjectVersions`/version-scoped delete, so once versioning has been turned on there is no path back to an empty, deletable bucket through this MCP server alone - same class of gap as the Audit Trail export-job case above, requiring a raw S3 SDK/CLI call outside the server to purge version history before `delete_bucket` will succeed.

## IAM Groups (issue #5): the issue's own API table was almost entirely correct, two small corrections

Live-probed 2026-08-18 - notably more accurate than issue #6's table (which needed correcting on 4
of 6 workstreams), because this one was checked against the endpoint-specific
`/developers/api/iam/groups/` page rather than a general overview. Confirmed correct as spec'd:
`GET`/`POST /groups`, `GET`/`PATCH`/`DELETE /groups/{id}`, `add-member`/`add-members`/`members`
(PUT)/`remove-member` all use the flat field shapes the issue described (`user_id`/`application_id`
singular for one-at-a-time, `user_ids[]`/`application_ids[]` plural arrays for bulk/overwrite - these
are real JSON field names, not URL brackets). Two corrections:

- **`list_groups`'s array filters are plain repeated query params, not bracket-suffixed.**
  `?group_ids[]=<id>` (as literally written in the issue) returns `400 invalid_arguments`;
  `?group_ids=<id>` (repeated for multiple: `&group_ids=<id2>`) is what actually works - confirmed
  via a positive control (filtered to exactly the "Administrators" preset group by id). Same for
  `user_ids`/`application_ids`.
- **`name` is an EXACT match, not a substring filter.** `?name=Admin` against a group literally
  named "Administrators" returns zero results; only `?name=Administrators` (the full exact name)
  matches. Unlike `permissionSets.ts`'s `name_filter`, which is deliberately client-side substring
  matching - don't assume the two work the same way.

**Special groups (`managed`/`all_users`/`all_applications`) could not be tested live on this org** -
`list_groups` returned exactly 3 groups (Administrators/Editors/Billing Administrators preset
groups), all with `managed: false`. The tool-side refusal therefore also checks `editable` /
`deletable` (the bits the spec says those special groups carry), and it now runs on every
membership mutation (`add_group_member(s)`, `set_group_members`, `remove_group_member`) as well as
`update_group`/`delete_group`. The `managed`/`all_users`/`all_applications` flags themselves have
never fired against a real special group on this org - worth a deliberate live check if an org
with one is ever available.

**A `try/finally` cleanup block needs its own error path - `process.exit()` skips `finally`
entirely.** Found while building this issue's smoke-test section: the file's shared `expectJson`
helper calls `console.error` + `process.exit(1)` on failure, which is fine everywhere it's used
top-level, but calling it *inside* a `try` block whose `finally` exists specifically to delete
throwaway resources means a failure past that point leaves the resources behind - `process.exit()`
terminates immediately, it does not unwind through pending `finally` blocks the way a thrown
exception does. Hit this for real: a `create_policy` call failed (missing required `rules` field, a
smoke-test bug, not a tool bug) partway through this section, and the throwaway group + Application
it had already created were left on the live account, caught only by a manual follow-up
`list_groups`/`list_applications` check. Fixed by adding a local `expectJsonOrThrow` (throws instead
of exiting) for every call inside the `try` block - `finally` runs correctly on a thrown exception.
The exact same bug, with the exact same fix, was already hit once before building issue #6's SSH-key
CRUD section - worth remembering as a standing rule for any *future* try/finally cleanup block added
to this file: never call `expectJson`/`process.exit` inside one, always throw.
