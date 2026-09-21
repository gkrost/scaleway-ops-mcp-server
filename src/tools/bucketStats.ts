import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetBucketLifecycleConfigurationCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3ServiceException,
  type LifecycleRule,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";
import { scwRegionSchema } from "../scwRegion.js";
import { scwBucketNameSchema } from "../scwBucket.js";

/**
 * Read-only bucket analytics (#76): object counts, bytes and age windows without paging raw
 * list_objects output by hand, plus a lifecycle audit that flags buckets whose retention config
 * says one thing while their objects say another - the 30-day-rule-but-39-day-old-objects drift
 * that motivated the issue.
 */

const bucketField = scwBucketNameSchema.describe("Bucket name, e.g. 'payments-backups'.");
const regionField = scwRegionSchema.optional().describe("Region to operate in. Defaults to the server's configured region (fr-par).");

const statsSchema = {
  bucket: bucketField,
  region: regionField,
  prefix: z.string().optional().describe("Only count objects under this prefix."),
  group_by: z
    .enum(["key-stem", "prefix", "none"])
    .default("key-stem")
    .describe(
      "'key-stem' (default): group by the object's file name with trailing timestamp-like segments stripped, e.g. " +
        "'zvg_pg_2026-09-21T01-30-00.dump' -> 'zvg_pg' - one row per backup series. 'prefix': group by folder. 'none': overall totals only.",
    ),
  max_objects: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(50_000)
    .describe("Safety cap on objects scanned. The result carries truncated=true when the bucket has more."),
};

const auditSchema = {
  bucket: bucketField.optional().describe("Audit just this bucket. Omit to audit every bucket in the region (config checks only - the deep object-age check below needs a single bucket)."),
  region: regionField,
  check_objects: z
    .boolean()
    .default(false)
    .describe(
      "Single-bucket mode only: list the bucket's objects (capped at 100,000) and compute the oldest object's age against the " +
        "smallest enabled expiration rule - flags retention drift (objects older than their rule should allow). Off by default: it pages the whole bucket.",
    ),
};

interface Aggregate {
  count: number;
  bytes: number;
  oldest: Date | null;
  newest: Date | null;
}

function newAggregate(): Aggregate {
  return { count: 0, bytes: 0, oldest: null, newest: null };
}

function add(a: Aggregate, size: number, lastModified: Date | undefined): void {
  a.count += 1;
  a.bytes += size;
  if (lastModified) {
    if (!a.oldest || lastModified < a.oldest) a.oldest = lastModified;
    if (!a.newest || lastModified > a.newest) a.newest = lastModified;
  }
}

function ageDays(d: Date, now: number): number {
  return Math.floor((now - d.getTime()) / 86_400_000);
}

/**
 * 'zvg_pg_2026-09-21T01-30-00.dump' -> 'zvg_pg': strip the extension, then drop trailing segments
 * (split on '_' and '-') that are purely numeric or a date-time fragment. Heuristic by design -
 * groups are labelled as derived, and a stem that strips to empty keeps its full base name.
 */
function keyStem(key: string): string {
  const base = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const segments = stem.split(/[_-]/);
  while (segments.length > 1 && /^(\d+|\d+T\d+)$/i.test(segments[segments.length - 1])) {
    segments.pop();
  }
  const joined = segments.join("_");
  return joined.length > 0 ? joined : base;
}

function groupKey(key: string, groupBy: "key-stem" | "prefix" | "none"): string {
  if (groupBy === "key-stem") return keyStem(key);
  if (groupBy === "prefix") return key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "(root)";
  return "all";
}

/** Page through the bucket's objects, aggregating into totals and per-group aggregates, up to the cap. */
async function aggregateObjects(
  client: S3Client,
  bucket: string,
  prefix: string | undefined,
  groupBy: "key-stem" | "prefix" | "none",
  maxObjects: number,
): Promise<{ totals: Aggregate; groups: Map<string, Aggregate>; scanned: number; truncated: boolean }> {
  const totals = newAggregate();
  const groups = new Map<string, Aggregate>();
  let scanned = 0;
  let truncated = false;
  let token: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of res.Contents ?? []) {
      if (scanned >= maxObjects) {
        truncated = true;
        break;
      }
      const size = o.Size ?? 0;
      add(totals, size, o.LastModified);
      const g = groupKey(o.Key ?? "", groupBy);
      let agg = groups.get(g);
      if (!agg) {
        agg = newAggregate();
        groups.set(g, agg);
      }
      add(agg, size, o.LastModified);
      scanned += 1;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && !truncated);
  return { totals, groups, scanned, truncated };
}

interface LifecycleSummary {
  bucket: string;
  has_configuration: boolean;
  read_error: string | null;
  rules: {
    id: string;
    status: string;
    expiration_days: number | null;
    expiration_date: Date | null;
    expired_object_delete_marker: boolean;
    has_prefix_or_filter: boolean;
    abort_incomplete_multipart_days: number | null;
  }[];
  enabled_expiration_days: number[];
  enabled_expiration_rule_count: number;
  enabled_abort_multipart: boolean;
}

async function summarizeLifecycle(client: S3Client, bucket: string): Promise<LifecycleSummary> {
  let rules: LifecycleRule[] = [];
  let hasConfiguration = true;
  try {
    const res = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    rules = res.Rules ?? [];
  } catch (err) {
    if (err instanceof S3ServiceException && err.name === "NoSuchLifecycleConfiguration") {
      hasConfiguration = false;
    } else {
      throw err;
    }
  }
  const enabled = rules.filter((r) => r.Status === "Enabled");
  return {
    bucket,
    has_configuration: hasConfiguration,
    read_error: null,
    rules: rules.map((r) => ({
      id: r.ID ?? "(no id)",
      status: r.Status ?? "?",
      expiration_days: r.Expiration?.Days ?? null,
      expiration_date: r.Expiration?.Date ?? null,
      expired_object_delete_marker: r.Expiration?.ExpiredObjectDeleteMarker === true,
      has_prefix_or_filter: Boolean(r.Prefix || r.Filter),
      abort_incomplete_multipart_days: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
    })),
    enabled_expiration_days: enabled.map((r) => r.Expiration?.Days).filter((d): d is number => typeof d === "number"),
    enabled_expiration_rule_count: enabled.filter((r) => r.Expiration?.Days !== undefined || r.Expiration?.Date !== undefined).length,
    enabled_abort_multipart: enabled.some((r) => r.AbortIncompleteMultipartUpload !== undefined),
  };
}

interface Finding {
  bucket: string;
  severity: "high" | "medium" | "low" | "info";
  code: string;
  detail: string;
}

export function registerBucketStats(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_bucket_stats",
    {
      title: "Read-only bucket stats: object count, bytes, age windows, per group",
      description:
        "Aggregate a bucket's objects in one call: total count, total bytes, and oldest/newest LastModified - overall and per group. " +
        "group_by='key-stem' strips trailing timestamp-like segments (backups become one row per series, exposing retention drift at a " +
        "glance); 'prefix' groups by folder. Pages the bucket internally (capped by max_objects, truncated flag when hit). Read-only.",
      inputSchema: statsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, prefix, group_by, max_objects }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const { totals, groups, scanned, truncated } = await aggregateObjects(client, bucket, prefix, group_by, max_objects);
        const groupList = [...groups.entries()]
          .map(([group, a]) => ({
            group,
            objects: a.count,
            total_bytes: a.bytes,
            oldest: a.oldest,
            newest: a.newest,
            age_oldest_days: a.oldest ? ageDays(a.oldest, Date.now()) : null,
          }))
          .sort((a, b) => b.total_bytes - a.total_bytes);
        return toolJsonResult(
          {
            bucket,
            prefix: prefix ?? null,
            group_by,
            objects_scanned: scanned,
            truncated,
            totals: {
              objects: totals.count,
              total_bytes: totals.bytes,
              oldest: totals.oldest,
              newest: totals.newest,
              age_oldest_days: totals.oldest ? ageDays(totals.oldest, Date.now()) : null,
            },
            groups: group_by === "none" ? undefined : groupList,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_audit_lifecycle",
    {
      title: "Audit lifecycle configuration: missing expiration / abort-MPU rules, retention drift",
      description:
        "Read-only. For one bucket or every bucket in the region, flag: no lifecycle configuration at all; no ENABLED expiration rule " +
        "(objects never expire); no ENABLED abort-incomplete-multipart rule (failed multipart uploads leave billed parts forever); disabled " +
        "rules that look like switched-off retention. With bucket + check_objects=true it also lists the bucket's objects (cap 100,000) and " +
        "checks retention drift only for bucket-wide day-based rules: the oldest object is older than the smallest enabled expiration_days allows. Rules with a prefix/filter or calendar date are reported but not used for that heuristic. Reports only - changing anything " +
        "stays an explicit confirm-gated call (scaleway_s3_put_bucket_lifecycle / add_lifecycle_rule).",
      inputSchema: auditSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, check_objects }) => {
      if (check_objects && !bucket) {
        return toolError("check_objects=true requires a single bucket - auditing every bucket's objects would page them all. Rerun per bucket.");
      }
      return handleS3(async () => {
        const client = getS3Client(config, region);
        const buckets = bucket ? [bucket] : (await client.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name ?? "").filter((n) => n !== "") ?? [];
        const findings: Finding[] = [];
        const summaries: LifecycleSummary[] = [];
        for (const b of buckets) {
          let s: LifecycleSummary;
          try {
            s = await summarizeLifecycle(client, b);
          } catch (err) {
            if (bucket) throw err;
            s = {
              bucket: b,
              has_configuration: false,
              read_error: err instanceof Error ? err.message : String(err),
              rules: [],
              enabled_expiration_days: [],
              enabled_expiration_rule_count: 0,
              enabled_abort_multipart: false,
            };
            summaries.push(s);
            findings.push({
              bucket: b,
              severity: "info",
              code: "lifecycle-unreadable",
              detail: `Could not read lifecycle configuration (${s.read_error}); this bucket is UNVERIFIED, not compliant.`,
            });
            continue;
          }
          summaries.push(s);
          if (!s.has_configuration) {
            findings.push({ bucket: b, severity: "medium", code: "no-lifecycle-rules", detail: "No lifecycle configuration: nothing ever expires and failed multipart uploads keep their parts forever." });
            continue;
          }
          if (s.enabled_expiration_rule_count === 0) {
            const disabledWithExpiration = s.rules.filter((r) => (r.expiration_days !== null || r.expiration_date !== null || r.expired_object_delete_marker) && r.status !== "Enabled");
            findings.push({
              bucket: b,
              severity: "medium",
              code: "no-enabled-expiration-rule",
              detail:
                disabledWithExpiration.length > 0
                  ? `No ENABLED expiration rule; ${disabledWithExpiration.map((r) => `'${r.id}' (${r.expiration_days ?? r.expiration_date ?? "delete-marker"}, ${r.status})`).join(", ")} look like switched-off retention.`
                  : "No ENABLED expiration rule: committed objects never expire.",
            });
          }
          if (!s.enabled_abort_multipart) {
            findings.push({
              bucket: b,
              severity: "low",
              code: "no-abort-multipart-rule",
              detail: "No ENABLED AbortIncompleteMultipartUpload rule: a failed multipart upload leaves its parts billed and invisible to object listings.",
            });
          }
        }
        let objectCheck: { bucket: string; oldest: Date | null; age_oldest_days: number | null; smallest_expiration_days: number | null; retention_drift_evaluable: boolean } | null = null;
        if (bucket && check_objects) {
          const { totals, truncated } = await aggregateObjects(client, bucket, undefined, "none", 100_000);
          const summary = summaries.find((s) => s.bucket === bucket);
          const dayRules = summary?.rules.filter((r) => r.status === "Enabled" && r.expiration_days !== null) ?? [];
          // A bucket-wide oldest-object comparison cannot establish drift for prefix/filter-scoped
          // rules (nor calendar-date expiration); reporting one as a high finding would be false.
          const evaluable = dayRules.length > 0 && dayRules.every((r) => !r.has_prefix_or_filter) && (summary?.enabled_expiration_rule_count ?? 0) === dayRules.length;
          const smallest = evaluable ? Math.min(...dayRules.map((r) => r.expiration_days as number)) : null;
          const ageOldest = totals.oldest ? ageDays(totals.oldest, Date.now()) : null;
          objectCheck = {
            bucket,
            oldest: totals.oldest,
            age_oldest_days: ageOldest,
            smallest_expiration_days: smallest,
            retention_drift_evaluable: evaluable,
          };
          if (smallest !== null && ageOldest !== null && ageOldest > smallest) {
            findings.push({
              bucket,
              severity: "high",
              code: "retention-drift",
              detail: `Oldest object is ${ageOldest} days old but the smallest enabled expiration rule is ${smallest} days - objects are outliving the rule (${truncated ? "scanned first 100,000 objects" : "all objects scanned"}).`,
            });
          }
          if (!evaluable && (summary?.enabled_expiration_rule_count ?? 0) > 0) {
            findings.push({
              bucket,
              severity: "info",
              code: "retention-drift-not-evaluated",
              detail: "Retention drift was not evaluated because enabled expiration rules use a prefix/filter or calendar date; a bucket-wide oldest-object comparison would be misleading.",
            });
          }
          if (truncated) {
            findings.push({ bucket, severity: "info", code: "object-scan-truncated", detail: "Object scan hit the 100,000 cap - age figures cover the scanned objects only." });
          }
        }
        findings.sort((a, b) => ["high", "medium", "low", "info"].indexOf(a.severity) - ["high", "medium", "low", "info"].indexOf(b.severity));
        return toolJsonResult(
          {
            region: region ?? config.SCW_DEFAULT_REGION,
            buckets_scanned: buckets.length,
            findings,
            finding_count: findings.length,
            per_bucket: summaries,
            object_check: objectCheck,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, bucket ? { config, bucket, region } : undefined);
    },
  );
}
