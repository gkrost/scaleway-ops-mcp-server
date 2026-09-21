import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetBucketPolicyCommand, ListBucketsCommand, S3ServiceException } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { IamApiError, iamListAll, iamRequest } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";
import { resolveOwnPrincipal } from "../ownPrincipal.js";
import { actionMatches, parseBucketPolicy, principalIds, type PolicyStatement } from "../policyEval.js";
import { scwRegionSchema } from "../scwRegion.js";

/**
 * Read-only org access audit (#81). The server can already READ everything a basic Scaleway access
 * audit needs - buckets, bucket policies (even where object access is denied), applications, API
 * keys - but cross-referencing them was manual. This tool does the joins and reports findings by
 * severity. It deliberately changes NOTHING: every fix stays an explicit, confirm-gated call to the
 * existing tools. The first manual pass (2026-09-21) that motivated it found a policy-less bucket, a
 * local dev stack reading prod attachments, and an orphaned never-expiring key.
 */

const SEVERITY_ORDER = ["high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

interface Finding {
  severity: Severity;
  area: "buckets" | "api-keys";
  resource: string;
  code: string;
  detail: string;
}

interface IamApplication {
  id: string;
  name: string;
  description?: string;
}

interface IamApiKey {
  access_key: string;
  application_id?: string;
  user_id?: string;
  description: string;
  created_at: string;
  expires_at?: string;
}

/** Env-stage vocabulary used in this org's names (apps: 'dev-...', buckets: 'dev.xxx'). */
const DEVISH = /\b(dev|local|staging|test|tests)\b/i;
const PRODISH = /\b(prod|production)\b/i;

function bucketIsDevish(name: string): boolean {
  // Both the dot-convention ('dev.zvg-backups') and hyphen forms count.
  return DEVISH.test(name);
}

/**
 * Dangerous (delete/abort/policy-rewriting) S3 actions in a statement - flagged wherever they are
 * granted, since "who is the bucket owner" is not resolvable from the policy document itself.
 */
const DANGEROUS_ACTIONS = [
  "s3:DeleteObject",
  "s3:DeleteBucket",
  "s3:AbortMultipartUpload",
  "s3:PutBucketPolicy",
  "s3:DeleteBucketPolicy",
  "s3:PutBucketAcl",
  "s3:BypassGovernanceRetention",
];

/** A statement mentioning "*" as principal, or granting destructive actions. */
function dangerousStatements(statements: PolicyStatement[]): { statement: PolicyStatement; kind: "star-principal" | "destructive-actions" }[] {
  const out: { statement: PolicyStatement; kind: "star-principal" | "destructive-actions" }[] = [];
  for (const st of statements) {
    if ((st.effect ?? "").toLowerCase() !== "allow") continue;
    if (st.principals.includes("*")) out.push({ statement: st, kind: "star-principal" });
    else if (st.actions.some((pattern) => DANGEROUS_ACTIONS.some((action) => actionMatches(pattern, action)))) out.push({ statement: st, kind: "destructive-actions" });
  }
  return out;
}

const auditSchema = {
  scope: z.enum(["all", "buckets", "keys"]).default("all").describe("Limit the audit to bucket-policy findings, API-key findings, or both (default)."),
  region: scwRegionSchema.optional()
    .describe("Region whose buckets to audit. Defaults to the server's configured region (fr-par). Buckets are region-scoped on Scaleway; IAM reads are org-wide."),
};

export function registerSecurityAudit(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_security_audit",
    {
      title: "Read-only security audit: buckets, bucket policies, principals, API keys",
      description:
        "Cross-reference what the server can already read - list_buckets, get_bucket_policy, list_applications, " +
        "list_api_keys - into severity-grouped findings, each naming the resource and the reason. Buckets: no Bucket " +
        "Policy (access decided by IAM alone); principals in a policy that no longer exist; cross-stage grants " +
        "(HEURISTIC - a dev/local-named application granted on a non-dev bucket or vice versa); statements granting " +
        "'*' (anonymous) or delete/abort/policy-rewrite actions. API keys: keys with no expiry; applications holding " +
        "several active keys; possibly-orphaned keys (HEURISTIC - a sibling key's description says the prior key was " +
        "lost/rotated/replaced while the old one still exists); this server's own key without expiry. READ-ONLY by " +
        "design: it reports, it never fixes - act on findings with the existing confirm-gated tools.",
      inputSchema: auditSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ scope, region }) => {
      try {
        return await runAudit(config, scope, region);
      } catch (err) {
        if (err instanceof IamApiError) {
          return toolError(
            `${err.message} - the audit needs this server's credential to READ applications and API keys (IAMUserReadOnly/IAMApplicationManager-level read). The S3 half may still work: rerun with scope='buckets'.`,
          );
        }
        throw err;
      }
    },
  );
}

async function runAudit(config: Config, scope: "all" | "buckets" | "keys", region: string | undefined) {
  return handleS3(async () => {
        const findings: Finding[] = [];
        const client = getS3Client(config, region);
        const applications = await iamListAll<IamApplication>(config, `/applications?organization_id=${config.SCW_ORGANIZATION_ID}`, "applications");
        const appById = new Map(applications.map((a) => [a.id, a]));

        // ---- API keys (#81) ----
        let keyCount = 0;
        if (scope !== "buckets") {
          const keys = await iamListAll<IamApiKey>(config, `/api-keys?organization_id=${config.SCW_ORGANIZATION_ID}`, "api_keys");
          keyCount = keys.length;
          const own = await resolveOwnPrincipal(config).catch(() => null);
          for (const k of keys) {
            if (k.expires_at) continue;
            const appName = k.application_id ? (appById.get(k.application_id)?.name ?? "(unknown app)") : `user ${k.user_id ?? "?"}`;
            const isOwn = own !== null && own.access_key === k.access_key;
            findings.push({
              severity: isOwn ? "high" : "medium",
              area: "api-keys",
              resource: k.access_key,
              code: isOwn ? "own-key-never-expires" : "key-never-expires",
              detail: isOwn
                ? `THIS server's own operating credential has no expiry. It holds this server's IAM grants (application/app keys management) - a leaked key is standing admin access. Add expires_at via scaleway_iam_update_api_key, or rotate to a key that has one.`
                : `Key for ${appName} has no expiry (${k.description}). Fine for a durable deployed service; a finding because expiry is the backstop when the service dies and nobody remembers the key.`,
            });
          }
          const byApp = new Map<string, IamApiKey[]>();
          for (const k of keys) {
            if (!k.application_id) continue;
            const list = byApp.get(k.application_id) ?? [];
            list.push(k);
            byApp.set(k.application_id, list);
          }
          const ROTATION_WORDS = /\b(lost|rotat|replac|prior|supersed|previous|old (key|secret))\b/i;
          for (const [appId, appKeys] of byApp) {
            const appName = appById.get(appId)?.name ?? appId;
            if (appKeys.length > 1) {
              findings.push({
                severity: "low",
                area: "api-keys",
                resource: appName,
                code: "multiple-active-keys",
                detail: `${appName} holds ${appKeys.length} active keys (${appKeys.map((k) => k.access_key).join(", ")}) - every one is a live credential to audit individually.`,
              });
            }
            // Rotation-orphan heuristic: a key whose description says the PRIOR credential was lost/rotated
            // away, while an older sibling key still exists, makes that older sibling a prime revoke candidate.
            const replacedMentions = appKeys.filter((k) => ROTATION_WORDS.test(k.description));
            for (const m of replacedMentions) {
              for (const older of appKeys) {
                if (older === m || older.created_at >= m.created_at) continue;
                findings.push({
                  severity: "medium",
                  area: "api-keys",
                  resource: older.access_key,
                  code: "possibly-orphaned-key",
                  detail: `Key ${older.access_key} for ${appName} predates ${m.access_key}, whose description says: "${m.description}". If that description refers to THIS key (lost/rotated/replaced), it is an orphaned standing credential - verify, then revoke with scaleway_iam_delete_api_key. HEURISTIC: confirm before acting.`,
                });
              }
            }
          }
        }

        // ---- Buckets & policies (#81) ----
        let bucketCount = 0;
        const unresolvedUserIds = new Set<string>();
        if (scope !== "keys") {
          const buckets = (await client.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name ?? "").filter((n) => n !== "") ?? [];
          bucketCount = buckets.length;
          for (const bucket of buckets) {
            let statements: PolicyStatement[] = [];
            try {
              const res = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
              statements = res.Policy ? parseBucketPolicy(JSON.parse(res.Policy)).statements : [];
            } catch (err) {
              if (err instanceof S3ServiceException && err.name === "NoSuchBucketPolicy") {
                findings.push({
                  severity: "medium",
                  area: "buckets",
                  resource: bucket,
                  code: "no-bucket-policy",
                  detail:
                    "No Bucket Policy: access is decided by the IAM layer alone, so ANY application holding a project-scope " +
                    "Object Storage permission set can reach this bucket - including delete if it holds ObjectStorageObjectsDelete. " +
                    "If that is intended, document it in a restrictive policy or a bucket tag.",
                });
              } else {
                findings.push({
                  severity: "info",
                  area: "buckets",
                  resource: bucket,
                  code: "policy-unreadable",
                  detail: `Bucket policy could not be read (${err instanceof Error ? err.message : String(err)}) - this bucket is UNVERIFIED, not clean.`,
                });
              }
              continue;
            }
            for (const d of dangerousStatements(statements)) {
              const sid = d.statement.sid ?? "(no Sid)";
              if (d.kind === "star-principal") {
                findings.push({
                  severity: "high",
                  area: "buckets",
                  resource: bucket,
                  code: "anonymous-principal-star",
                  detail: `Statement '${sid}' grants ${d.statement.actions.join(", ")} to Principal "*" - anonymous access (subject to Scaleway's bucket visibility). Verify this is deliberate.`,
                });
              } else {
                findings.push({
                  severity: "medium",
                  area: "buckets",
                  resource: bucket,
                  code: "destructive-actions-granted",
                  detail: `Statement '${sid}' grants destructive action pattern(s) ${d.statement.actions.filter((pattern) => DANGEROUS_ACTIONS.some((action) => actionMatches(pattern, action))).join(", ")} to ${d.statement.principals.join(", ")}. Check each principal needs delete/abort capability on this bucket.`,
                });
              }
            }
            // Dangling principals + cross-stage heuristic.
            for (const p of principalIds({ version: null, statements })) {
              if (p === "*") continue;
              const m = /^(application_id|user_id):(.+)$/.exec(p);
              if (!m) continue;
              const [, kind, id] = m;
              if (kind === "application_id") {
                const app = appById.get(id);
                if (!app) {
                  findings.push({
                    severity: "medium",
                    area: "buckets",
                    resource: bucket,
                    code: "dangling-principal",
                    detail: `Policy grants to application_id:${id}, which no longer exists (deleted Application). A dead grant is confusing at best; at worst the id gets reused by a future principal. Remove the statement (scaleway_s3_remove_bucket_policy_statement).`,
                  });
                  continue;
                }
                const appStage = `${app.name} ${app.description ?? ""}`;
                if (DEVISH.test(appStage) && !bucketIsDevish(bucket)) {
                  findings.push({
                    severity: "low",
                    area: "buckets",
                    resource: bucket,
                    code: "cross-stage-grant",
                    detail: `HEURISTIC: application '${app.name}' looks dev/local/staging-named ('${appStage.trim()}') but is granted on non-dev bucket '${bucket}'. May be intended (e.g. read-only), but this is exactly the shape of the local-dev-reads-prod case.`,
                  });
                } else if (PRODISH.test(appStage) && bucketIsDevish(bucket)) {
                  findings.push({
                    severity: "low",
                    area: "buckets",
                    resource: bucket,
                    code: "cross-stage-grant",
                    detail: `HEURISTIC: application '${app.name}' looks prod-named but is granted on dev/staging bucket '${bucket}'.`,
                  });
                }
              } else {
                unresolvedUserIds.add(id);
              }
            }
          }
        }
        // Resolve user_id principals against the real Users API (deduped, bounded).
        const uncheckedUserIds = Math.max(0, unresolvedUserIds.size - 50);
        for (const id of [...unresolvedUserIds].slice(0, 50)) {
          try {
            await iamRequest<{ id: string }>(config, "GET", `/users/${id}`);
          } catch (err) {
            if (err instanceof IamApiError && err.status === 404) {
              findings.push({
                severity: "medium",
                area: "buckets",
                resource: id,
                code: "dangling-principal",
                detail: `A bucket policy grants to user_id:${id}, which no longer exists. Remove the statement (scaleway_s3_remove_bucket_policy_statement).`,
              });
            } else {
              findings.push({
                severity: "info",
                area: "buckets",
                resource: id,
                code: "principal-unverified",
                detail: `Could not verify user_id:${id} (${err instanceof Error ? err.message : String(err)}); it is not being reported as dangling.`,
              });
            }
          }
        }
        findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
        const summary = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]));
        return toolJsonResult(
          {
            region: region ?? config.SCW_DEFAULT_REGION,
            scope,
            buckets_scanned: bucketCount,
            api_keys_scanned: keyCount,
            applications_scanned: applications.length,
            finding_count: findings.length,
            summary,
            findings,
            note:
              "READ-ONLY: this tool reports, it never changes anything. HEURISTIC findings are labelled as such - verify before acting. " +
              (uncheckedUserIds > 0 ? `${uncheckedUserIds} user_id principals were not checked (50-lookup cap).` : "").trim(),
          },
          config.MAX_OUTPUT_CHARS,
        );
      });
}
