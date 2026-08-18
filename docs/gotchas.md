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

## Console navigation friction is unrelated to any of the above

Provisioning this same credential manually through the web console (before this server existed)
hit repeated silent click failures on sensitive actions (attaching a policy, generating an API
key) that turned out to be a permission classifier gating those specific actions in that
environment - unrelated to anything about Scaleway's own API or console. Not relevant here since
this server talks to the API directly, but noted in case a future console-automation attempt hits
the same wall.
