# IAM policy naming review (2026-08-18)

Reviewed all 13 IAM Policies in the Organization via `scaleway_iam_list_policies`/
`scaleway_iam_list_applications`. Naming had drifted across three inconsistent conventions
(dot vs. dash env prefixes, underscore vs. dash word separators, policy names colliding with
their Application's own name, remediation history baked into the name instead of the
description). `Administrators`/`Billing Administrators`/`Editors` are Scaleway's own default
org groups and were left out of scope.

## Convention adopted

`<env>-<subject>-<access-level>[-<scope>]`, dash-separated throughout (no dots, no
underscores). Every Object-Storage-scoped policy gets an explicit `-storage` (or `-iam`,
`-iam-and-storage`) suffix so it never collides with its Application's identically-themed name.
Historical/remediation context (ticket numbers, "why") stays in `description`, not the name -
per the "Renaming an Application or Policy is always safe" entry in [gotchas.md](gotchas.md).

## Renames applied and confirmed (10/10)

Applied via `scaleway_iam_update_policy` (`name` field only - no rule/principal/tag changes,
no credential rotation). Confirmed live via a follow-up `scaleway_iam_list_policies`:
`nb_rules`/`nb_scopes`/`nb_permission_sets` unchanged on every policy.

| Old name | New name |
|---|---|
| `claude-code-operation` | `claude-code-operator-base` |
| `claude-code-operation-IAM` | `claude-code-operator-iam` |
| `dev.zvg-files-least-privilege_object_storage` | `dev-zvg-files-least-privilege-storage` |
| `dev.zvg-files-least-privilege_object_storage_listbucket_fix` | `dev-zvg-files-least-privilege-storage-listbucket` |
| `local-zvg-files-readonly` | `local-zvg-files-readonly-storage` |
| `prod-immo-user-documents-rw` | `prod-immo-user-documents-rw-storage` |
| `prod-zvg-backups-rw` | `prod-zvg-backups-rw-storage` |
| `prod.zvg-files-least-privilege_object_storage` | `prod-zvg-files-least-privilege-storage` |
| `scaleway-ops-mcp_iam_and_storage` | `scaleway-ops-mcp-iam-and-storage` |
| `zvg-backups-least-privilege_object_storage` | `dev-zvg-backups-least-privilege-storage` |

## Follow-up: Application names (2026-08-18, same day)

The dot-vs-dash inconsistency flagged above at the Application-name layer was fixed the same
day via `scaleway_iam_update_application` (`name` field only, same "always safe" basis -
Bucket Policies and API keys reference `application_id`, never the name). Confirmed live via a
follow-up `scaleway_iam_list_applications`: `nb_api_keys` unchanged on every one.

| Old name | New name |
|---|---|
| `dev.zvg-files-least-privilege` | `dev-zvg-files-least-privilege` |
| `prod.zvg-files-least-privilege` | `prod-zvg-files-least-privilege` |
| `zvg-backups-least-privilege` | `dev-zvg-backups-least-privilege` (also picked up the missing `dev-` prefix - its own description already scoped it to dev-only) |

`unidrive-scaleway-test`, `claude-code-operator`, `scaleway-ops-mcp`, `local-zvg-files-readonly`,
`prod-zvg-backups-rw`, and `prod-immo-user-documents-rw` were already dash-only and needed no
change. Every Application name in the Organization is now dash-separated with a consistent
`dev-`/`prod-`/`local-` (or no) environment prefix.
