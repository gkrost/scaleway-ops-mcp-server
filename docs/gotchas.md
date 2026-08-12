# Scaleway API gotchas this server exists to paper over

All found empirically, 2026-08-12, provisioning the `zvg-backups-least-privilege` credential for
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

## Console navigation friction is unrelated to any of the above

Provisioning this same credential manually through the web console (before this server existed)
hit repeated silent click failures on sensitive actions (attaching a policy, generating an API
key) that turned out to be a permission classifier gating those specific actions in that
environment - unrelated to anything about Scaleway's own API or console. Not relevant here since
this server talks to the API directly, but noted in case a future console-automation attempt hits
the same wall.
