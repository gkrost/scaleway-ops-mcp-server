# MVP / public-release review (2026-08-18)

Scope: read `README.md` + `docs/gotchas.md`, all of `src/`, `scripts/smoke-test.mjs`,
`package.json`, `tsconfig.json`, git history/tracked-file list. `npm run build` passes clean
(TypeScript `strict: true`, no compiler errors).

## Bugs / correctness issues

1. **Unhandled `JSON.parse` on non-JSON response bodies** — `src/iamClient.ts:65` and
   `src/auditClient.ts:30` both do `text ? JSON.parse(text) : undefined` unconditionally, for
   both success and error responses. A non-JSON body (HTML from a gateway timeout/502, a plain-text
   429, a proxy error page) throws a raw `SyntaxError` that is **not** an `IamApiError`/
   `AuditTrailApiError`, so `withIamErrorHandling`/`handleAudit` (which only catch their specific
   error class) rethrow it uncaught instead of returning a clean tool error. Same class of gap in
   `src/tools/bucketPolicies.ts`'s `handleS3`, which only catches `S3ServiceException` — a raw
   network error (DNS failure, timeout) propagates unhandled. Low likelihood, but when it happens
   the failure mode is an opaque crash instead of the informative `toolError()` message the rest of
   the codebase is careful to produce everywhere else. Fix: wrap the `JSON.parse` in a try/catch
   that falls back to the raw text, and widen the three handlers to catch `Error` generically as a
   last resort.

2. **`ruleSchema` doesn't enforce "exactly one of `project_ids`/`organization_id`"**
   (`src/tools/policies.ts:31-47`) — it's stated in the `.describe()` text but not enforced with a
   `.refine()`. A caller (human or agent) can pass both, or neither, and only find out via a late
   400 from Scaleway instead of an immediate, clear Zod validation error. Same applies to
   `resources`/statement shape in `scaleway_s3_put_bucket_policy`'s `policy_json`, which is
   necessarily a free-form string and can't be schema-validated the same way — not a bug there,
   just a reminder this one is the one place it's realistically fixable.

Nothing else rose to the level of a real bug — the API-quirk handling (pagination, rules living at
`/rules` not `/policies/{id}/rules`, replace-vs-merge semantics, `application_id` filter being
server-side-ignored on `/policies`) is already correct and documented in `docs/gotchas.md`. Error
messages consistently surface Scaleway's `details[]` array rather than just `message`. Destructive
tools all gate on `confirm: true`. Secrets are handled correctly: `create_api_key` returns
`secret_key` once (matches Scaleway's own one-time-reveal semantics), `list_api_keys` never returns
it, and nothing logs or persists a secret server-side.

## MVP / public-GitHub readiness

**Blocking / should fix before making the repo public — both resolved 2026-08-18:**

- ~~Org-internal naming convention baked into tool schema descriptions~~ — **fixed**: the `zvg`
  example codename in `src/tools/applications.ts`, `src/tools/policies.ts`,
  `src/tools/bucketPolicies.ts`, and `docs/gotchas.md` was replaced with a generic `payments`
  placeholder. No account-identifying names remain in tool descriptions.
- ~~No `LICENSE` file~~ — **fixed**: added `LICENSE` (MIT, matching `package.json`'s declared
  license), copyright Gernot Krost, 2026.

**Remaining, not blocking:**

- **Untracked `jfr-analyzer.log` in the repo root** — leftover debug output from an unrelated tool
  (a separate Java/Quarkus MCP server), not related to this project. It's not tracked and won't be
  committed accidentally, but delete it (or it'll get picked up by a future `git add -A`) — it adds
  noise, not risk.

**Confirmed safe (checked, not assumed):**

- `.env` (real live credentials) was never committed — `git log --all -- .env` returns nothing —
  and is correctly gitignored. No rotation needed on that basis alone.
- `dist/` (build output) is gitignored and not tracked.
- No other secrets, tokens, or credential-shaped strings found in tracked files.

**Worth doing, not blocking:**

- No CI (`.github/workflows`) — `npm run build` (a clean `tsc` typecheck) costs nothing to wire up
  as a GitHub Actions job on push/PR, and is the obvious first thing a public repo's badge should
  show green.
- No automated tests — the only test path is `scripts/smoke-test.mjs`, which by design needs live,
  privileged Scaleway credentials and mutates real account state (create/get/delete a throwaway
  Application). That's fine to keep as a manual dev utility, but it means there's zero test coverage
  that runs in CI or without real credentials. A handful of pure unit tests would be feasible for
  the parts that don't need the network: `formatIamErrorBody`, `truncate`, `iamListAll`'s pagination
  loop (with a mocked `fetch`).
- `README.md` references "the `scaleway-ops-mcp` Application (provisioned 2026-08-12)... reuse its
  credential" — accurate for your own account, but reads as an instruction to a stranger who won't
  have that Application. Fine to leave (it's clearly account-specific context) but consider a short
  "adjust this to your own account" caveat if the README is meant to double as onboarding for other
  users, not just you.
- No `CONTRIBUTING.md`/issue templates — optional for a small single-maintainer tool, skip unless
  you want outside contributions.

**Bottom line:** the implementation itself is solid — correct handling of every documented Scaleway
API quirk, consistent error surfacing, sane Zod schemas, destructive-action confirmation gates, no
secret leakage. The two things that actually need a decision before flipping this public are the
`zvg`-naming disclosure question and the missing `LICENSE` file; everything else is polish.
