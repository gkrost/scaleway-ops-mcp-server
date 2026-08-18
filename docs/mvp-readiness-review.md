# MVP / public-release review (2026-08-18, refreshed)

Scope: `README.md` + `docs/gotchas.md` + `docs/capability-gap-analysis.md`, all of `src/`
(13 files, ~3,460 lines, 84 registered tools across 12 tool modules), `scripts/smoke-test.mjs`,
`package.json`, `tsconfig.json`, `.github/workflows/ci.yml`, and full git history (`git log --all`)
for committed secrets. `npm run build` (`tsc`, `strict: true`) and `npm audit` both pass clean.
Supersedes the same-day earlier version of this file, written before issues #4 (Users), #7 (bucket
configuration), #8 (object operations), and the remaining Audit Trail surface (#9) landed - all four
are reflected below. Issue #6 (SSH Keys/JWTs/SAML/SCIM/Security Settings) is open as PR #16 at time
of writing and NOT included in this snapshot's line/tool counts.

## Bugs / correctness issues

1. **Unhandled `JSON.parse` on non-JSON response bodies - still open.** `src/iamClient.ts` and
   `src/auditClient.ts` both do `text ? JSON.parse(text) : undefined` unconditionally, for both
   success and error responses, with no try/catch. A non-JSON body (HTML from a gateway
   timeout/502, a plain-text 429, a proxy error page) throws a raw `SyntaxError` - not an
   `IamApiError`/`AuditTrailApiError` - so `withIamErrorHandling`/`handleAudit` (which only catch
   their specific error class) rethrow it uncaught instead of returning a clean tool error. Same gap
   in `s3Client.ts`'s `handleS3`, which only catches `S3ServiceException` - a raw network error (DNS
   failure, timeout) propagates unhandled. Low likelihood, but the failure mode is an opaque crash
   instead of the informative `toolError()` message the rest of the codebase produces everywhere
   else. Still the right fix: wrap the `JSON.parse` in a try/catch that falls back to the raw text,
   and widen the three handlers to catch `Error` generically as a last resort.
2. **`ruleSchema` still doesn't enforce "exactly one of `project_ids`/`organization_id`"**
   (`src/tools/policies.ts`) - stated in `.describe()` text but not a Zod `.refine()`. A caller can
   pass both or neither and only find out via a late 400 from Scaleway instead of an immediate,
   clear validation error.

Nothing else rose to the level of a real bug across the newer files (`objects.ts`, `bucketConfig.ts`,
`users.ts`, the audit-trail trio) - the same care evident in the original review's scope carries
through: consistent error surfacing via `handleS3`/`withIamErrorHandling`, destructive tools gated on
`confirm: true` (including two genuinely one-way doors - `scaleway_s3_enable_object_lock` and
versioning-suspend-while-locked - both loudly documented as irreversible), full-replace-not-merge
semantics called out everywhere they apply (tags, CORS, lifecycle, bucket policies), and no secret
leakage: `create_api_key`'s `secret_key` is one-time-reveal like Scaleway's own console, presigned
URLs expire, nothing logs or persists a credential server-side. One real bug **was** found and fixed
this session, outside this review's normal read-only scope: `scaleway_iam_update_user_password`
silently dropped the caller's `password` from the request body entirely (PR #15 review, fixed same
day) - worth noting because it shipped past the author's own smoke-test coverage, which guarded the
*missing-confirm* path but never exercised the *confirm:true* handler for that one tool. A
lesson for future negative-test loops: grouping many tools into one generic "expect isError" loop can
silently omit one without anyone noticing, unless a matching guard/handler pair is checked for every
tool in the file, not just most of them.

## MVP / public-GitHub readiness

**Confirmed safe (checked fresh, not assumed):**

- `.env` (real live credentials) was never committed, in any branch fetched into this checkout,
  including the currently-open issue #6 branch - `git log --all --oneline -- .env` returns nothing.
- Full `git log --all -p` history scan for credential-shaped strings and PEM key blocks: the only
  `BEGIN ... PRIVATE KEY` hits are from issue #6's own SSH-key tooling - a hardcoded *fake* rejection-
  test fixture and the detection regex that flags real ones, not a leaked key.
- `npm audit` (production dependencies): 0 vulnerabilities.
- `dist/` is gitignored and not tracked. `LICENSE` (MIT) is present and matches `package.json`.

**Worth doing before/around a public release, not blocking:**

- **No automated test suite runs in CI or without live credentials.** `package.json` has no `test`
  script at all (`npm test` errors: `missing script: test`). `.github/workflows/ci.yml` runs only
  `npm run build` (a `tsc` typecheck) - genuinely useful as a merge gate (it's what caught nothing
  wrong here, correctly, since the build is clean) but it is not test coverage. The only test path
  remains `scripts/smoke-test.mjs`, which by design needs live, privileged Scaleway credentials and
  mutates real account state. That's the right tool for what it does (and it's gotten considerably
  more thorough since the original version of this review - it now round-trips text/binary objects
  byte-for-byte, verifies a real presigned-URL fetch, and cross-validates against the console UI) but
  it means zero coverage exists that a contributor without account credentials, or CI, can run. A
  handful of pure unit tests remain feasible for the credential-free parts: `formatIamErrorBody`/
  `formatAuditErrorBody`, `truncate`, `iamListAll`'s pagination loop and `isUtf8Text`/
  `encodeKeyForCopySource` in `objects.ts` (all pure functions with mocked/no I/O).
- **The two correctness issues above** (unguarded `JSON.parse`, missing `ruleSchema` refine) - both
  low-severity, low-likelihood, but cheap fixes that would close out this review's remaining
  findings entirely.
- `README.md`'s credential section still reads as account-specific onboarding ("the
  `scaleway-ops-mcp` Application... reuse its credential") - accurate for the maintainer, reads as an
  instruction to a stranger. Low priority unless the README is meant to double as onboarding for
  other users.
- No `CONTRIBUTING.md`/issue templates - optional for a small, largely single-maintainer tool with
  heavy agent-assisted development; skip unless outside contributions are actually wanted.
- Surface area has grown substantially (13 -> 21 files, 8 -> 84 tools, and issue #6 will add ~23
  more) with each new tool module following the established conventions closely - genuinely
  consistent quality across contributors/sessions, not just the original files. Worth a periodic
  audit pass like this one as the tool count keeps climbing, since consistency at 84 tools takes more
  active maintenance than it did at the original review's much smaller footprint.

## Bottom line

Nothing new blocks a public release. Both items flagged as **blocking** in the original review - the
account-identifying `zvg` example codename and the missing `LICENSE` file - were already fixed the
same day they were found and remain fixed. The two correctness issues carried forward from that
review (unguarded `JSON.parse`, the `ruleSchema` refine gap) are still open, still low-severity, and
still the right things to knock out opportunistically. The codebase has roughly 10x'd in tool count
since the original review and the engineering bar has held: every new file follows the same
conventions (confirm-guards on destructive ops, full-replace semantics called out explicitly,
live-probed rather than doc-assumed API behavior, errors surfaced with Scaleway's actual detail
array), and the one real bug that did slip through (the password-update body omission) was caught by
independent PR review the same day, not by this audit - a good sign the review process, not just the
code, is working. The main structural gap for a public release remains the same as before: no
credential-free automated test coverage, which is a real cost for outside contributors even though
it's a reasonable tradeoff for a single-maintainer tool that leans on live verification instead.
