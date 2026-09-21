import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetObjectLockConfigurationCommand,
  PutBucketAclCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutBucketWebsiteCommand,
  PutObjectLockConfigurationCommand,
  DeleteBucketCorsCommand,
  DeleteBucketEncryptionCommand,
  DeleteBucketLifecycleCommand,
  DeleteBucketTaggingCommand,
  DeleteBucketWebsiteCommand,
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
 * Bucket-level configuration management (issue #7): tagging, CORS, versioning, website,
 * visibility (ACL), lifecycle rules, encryption config, and object lock. Behavior facts in the
 * descriptions below were live-verified against fr-par on 2026-08-18 with throwaway buckets -
 * see docs/gotchas.md for the probe evidence. Bucket logging and bucket metrics are NOT here:
 * Scaleway's S3 endpoint returns NotImplemented for both (live-verified 2026-08-18).
 */
const bucketField = scwBucketNameSchema.describe("Bucket name.");
const regionField = scwRegionSchema.optional().describe("Region to operate in. Defaults to the server's configured region (fr-par).");
const confirmField = z.literal(true).describe("Must be explicitly true.");

const ALL_USERS_URI = "http://acs.amazonaws.com/groups/global/AllUsers";

/**
 * One lifecycle rule as the put tool accepts it (#74). Element names follow Scaleway's lifecycle
 * doc (docs-content pages/object-storage/api-cli/lifecycle-rules-api.mdx): Expiration.Days,
 * Transition, NoncurrentVersionExpiration.NoncurrentDays, and
 * AbortIncompleteMultipartUpload.DaysAfterInitiation are all documented there.
 */
const lifecycleRuleSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean(),
    prefix: z.string().optional().describe("Rule applies only to keys under this prefix. Omit for all objects."),
    expiration_days: z.number().int().min(1).optional().describe("Permanently delete objects this many days after creation. Omit to keep. DESTRUCTIVE."),
    noncurrent_expiration_days: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Versioned buckets: permanently delete an object version this many days after it becomes non-current " +
          "(NoncurrentVersionExpiration.NoncurrentDays). DESTRUCTIVE. No effect on a bucket that was never versioned.",
      ),
    transitions: z
      .array(z.object({ days: z.number().int().min(0), storage_class: z.enum(["ONEZONE_IA", "GLACIER"]) }))
      .optional()
      .describe("Move objects to a colder storage class after N days."),
    abort_incomplete_multipart_days: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Abort multipart uploads still incomplete this many days after they were initiated, deleting the parts " +
          "uploaded so far (AbortIncompleteMultipartUpload.DaysAfterInitiation). Deletes no committed object, but " +
          "also kills a legitimate upload still running past this age. 1 is the usual value.",
      ),
  })
  .refine(
    (r) =>
      r.expiration_days !== undefined ||
      r.noncurrent_expiration_days !== undefined ||
      r.abort_incomplete_multipart_days !== undefined ||
      (r.transitions?.length ?? 0) > 0,
    (r) => ({
      message:
        `Lifecycle rule '${r.id}' has no action - set at least one of expiration_days, noncurrent_expiration_days, ` +
        "abort_incomplete_multipart_days, or a non-empty transitions list.",
    }),
  );

type LifecycleRuleInput = z.infer<typeof lifecycleRuleSchema>;

/** True when a requested rule's only action is aborting incomplete multipart uploads (no committed object is deleted). */
function isAbortOnlyInput(r: LifecycleRuleInput): boolean {
  return (
    r.abort_incomplete_multipart_days !== undefined &&
    r.expiration_days === undefined &&
    r.noncurrent_expiration_days === undefined &&
    (r.transitions?.length ?? 0) === 0
  );
}

/**
 * True when a rule currently on the bucket carries no action other than AbortIncompleteMultipartUpload, so a
 * full-replace PUT that drops or rewrites it cannot stop any expiration or transition. Anything this server
 * does not model (NoncurrentVersionTransitions, Expiration.Date, ExpiredObjectDeleteMarker) counts as "other".
 */
function isAbortOnlyExisting(r: LifecycleRule): boolean {
  const e = r.Expiration;
  const nve = r.NoncurrentVersionExpiration;
  const expires = e !== undefined && (e.Days !== undefined || e.Date !== undefined || e.ExpiredObjectDeleteMarker !== undefined);
  const noncurrentExpires = nve !== undefined && (nve.NoncurrentDays !== undefined || nve.NewerNoncurrentVersions !== undefined);
  return !expires && !noncurrentExpires && (r.Transitions?.length ?? 0) === 0 && (r.NoncurrentVersionTransitions?.length ?? 0) === 0;
}

/** The bucket's current lifecycle rules, or [] when it has none (NoSuchLifecycleConfiguration). */
async function currentLifecycleRules(client: S3Client, bucket: string): Promise<LifecycleRule[]> {
  try {
    const res = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    return res.Rules ?? [];
  } catch (err) {
    if (err instanceof S3ServiceException && err.name === "NoSuchLifecycleConfiguration") return [];
    throw err;
  }
}

/** SDK-shape LifecycleRule from the tool's input schema - the single mapping put/add share. */
function toSdkRule(r: LifecycleRuleInput): LifecycleRule {
  return {
    ID: r.id,
    Status: r.enabled ? "Enabled" : "Disabled",
    // Scaleway documents an empty Prefix as "applies to all objects" and uses exactly this form in its
    // own abort-incomplete-multipart example; sending no Filter at all is undocumented there.
    Filter: { Prefix: r.prefix ?? "" },
    Expiration: r.expiration_days ? { Days: r.expiration_days } : undefined,
    NoncurrentVersionExpiration: r.noncurrent_expiration_days ? { NoncurrentDays: r.noncurrent_expiration_days } : undefined,
    Transitions: r.transitions?.map((t) => ({ Days: t.days, StorageClass: t.storage_class })),
    AbortIncompleteMultipartUpload: r.abort_incomplete_multipart_days ? { DaysAfterInitiation: r.abort_incomplete_multipart_days } : undefined,
  };
}

/** Deterministic JSON for structural comparison - key order must not create phantom diffs. */
function canon(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, sort(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(sort(v));
}

interface RuleDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

/** By-ID structural diff between the bucket's current rules and a desired set (#80). */
function diffRules(current: LifecycleRule[], desired: LifecycleRule[]): RuleDiff {
  const keyOf = (r: LifecycleRule) => r.ID ?? "(no id)";
  const cur = new Map(current.map((r) => [keyOf(r), r]));
  const want = new Map(desired.map((r) => [keyOf(r), r]));
  const diff: RuleDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [id, w] of want) {
    const c = cur.get(id);
    if (!c) diff.added.push(id);
    else if (canon(c) === canon(w)) diff.unchanged.push(id);
    else diff.changed.push(id);
  }
  for (const id of cur.keys()) if (!want.has(id)) diff.removed.push(id);
  return diff;
}

export function registerBucketConfig(server: McpServer, config: Config) {
  // ---------- Tagging ----------
  server.registerTool(
    "scaleway_s3_get_bucket_tagging",
    {
      title: "Get Scaleway bucket tags",
      description: "Read a bucket's tags (key/value pairs). Errors with NoSuchTagSet if no tags are set.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketTaggingCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, tags: res.TagSet ?? [] }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_tagging",
    {
      title: "Set Scaleway bucket tags (full replace)",
      description:
        "Set a bucket's tags. FULL-REPLACE semantics: the provided list becomes the complete tag set - tags not in the list are removed. Requires confirm=true (full-replace).",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        tags: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1).describe("The COMPLETE tag set to apply."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, tags, confirm }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(
          new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tags.map((t) => ({ Key: t.key, Value: t.value })) } }),
        );
        return toolJsonResult({ bucket, applied: tags.length, tags }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_tagging",
    {
      title: "Delete Scaleway bucket tags",
      description: "Remove ALL tags from a bucket. Requires confirm=true. Reversible in the sense that tags can be re-applied, but the current set is lost.",
      inputSchema: { bucket: bucketField, region: regionField, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- CORS ----------
  server.registerTool(
    "scaleway_s3_get_bucket_cors",
    {
      title: "Get Scaleway bucket CORS rules",
      description: "Read a bucket's CORS rules. Errors with NoSuchCORSConfiguration if none are set.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketCorsCommand({ Bucket: bucket }));
        const rules = (res.CORSRules ?? []).map((r) => ({
          allowed_origins: r.AllowedOrigins ?? [],
          allowed_methods: r.AllowedMethods ?? [],
          allowed_headers: r.AllowedHeaders ?? [],
          expose_headers: r.ExposeHeaders ?? [],
          max_age_seconds: r.MaxAgeSeconds,
        }));
        return toolJsonResult({ bucket, rules }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_cors",
    {
      title: "Set Scaleway bucket CORS rules (full replace)",
      description:
        "Set a bucket's CORS rules. FULL-REPLACE semantics: the provided list becomes the complete rule set - existing rules not in the list are removed. This loosens or restricts browser cross-origin access to the bucket. Requires confirm=true (full-replace).",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        rules: z
          .array(
            z.object({
              allowed_origins: z.array(z.string()).min(1),
              allowed_methods: z.array(z.enum(["GET", "PUT", "POST", "DELETE", "HEAD"])).min(1),
              allowed_headers: z.array(z.string()).optional(),
              expose_headers: z.array(z.string()).optional(),
              max_age_seconds: z.number().int().min(0).optional(),
            }),
          )
          .min(1)
          .describe("The COMPLETE CORS rule set to apply."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, rules, confirm }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(
          new PutBucketCorsCommand({
            Bucket: bucket,
            CORSConfiguration: {
              CORSRules: rules.map((r) => ({
                AllowedOrigins: r.allowed_origins,
                AllowedMethods: r.allowed_methods,
                AllowedHeaders: r.allowed_headers,
                ExposeHeaders: r.expose_headers,
                MaxAgeSeconds: r.max_age_seconds,
              })),
            },
          }),
        );
        return toolJsonResult({ bucket, applied: rules.length, rules }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_cors",
    {
      title: "Delete Scaleway bucket CORS rules",
      description: "Remove ALL CORS rules from a bucket - browsers regain no cross-origin access (default-deny).",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketCorsCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Versioning ----------
  server.registerTool(
    "scaleway_s3_get_bucket_versioning",
    {
      title: "Get Scaleway bucket versioning state",
      description:
        "Read a bucket's versioning state: '' (never enabled), 'Enabled', or 'Suspended'. Note: once Object Lock is enabled on a bucket, versioning is frozen at Enabled and cannot be suspended (live-verified 2026-08-18).",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketVersioningCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, status: res.Status ?? "" }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_set_bucket_versioning",
    {
      title: "Enable or suspend Scaleway bucket versioning",
      description:
        "Set versioning to Enabled or Suspended. Enabling keeps every object version (deletes create delete markers instead of removing data). Suspending requires confirm=true: new writes stop versioning, existing versions are retained. VERSIONING CAN NEVER GO BACK TO 'never-enabled' - suspending is not disabling. Suspending fails outright (InvalidBucketState) while Object Lock is enabled on the bucket.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        status: z.enum(["Enabled", "Suspended"]),
        confirm: confirmField.optional().describe("Required true when status=Suspended."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, status, confirm }) =>
      handleS3(async () => {
        if (status === "Suspended" && confirm !== true) {
          return toolError("Suspending versioning requires confirm: true (it stops new versioning and is not reversible back to 'never-enabled').") as never;
        }
        await getS3Client(config, region).send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: status } }));
        return toolJsonResult({ bucket, status }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Website ----------
  server.registerTool(
    "scaleway_s3_get_bucket_website",
    {
      title: "Get Scaleway bucket website configuration",
      description:
        "Read a bucket's static-website configuration. Errors with NoSuchWebsiteConfiguration if none is set.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketWebsiteCommand({ Bucket: bucket }));
        return toolJsonResult(
          { bucket, index_document: res.IndexDocument?.Suffix ?? null, error_document: res.ErrorDocument?.Key ?? null },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_website",
    {
      title: "Set Scaleway bucket website configuration (full replace)",
      description:
        "Configure the bucket for static-website serving (index document, optional error document). FULL-REPLACE. Requires confirm=true because this publishes an HTTP website endpoint for the bucket. The website endpoint follows Scaleway's s3-website.<region>.scw.cloud naming - check the console bucket page for the exact URL; anonymous website access on Scaleway additionally depends on the bucket's visibility (see scaleway_s3_set_bucket_visibility).",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        index_document: z.string().min(1).describe("Index document suffix, e.g. 'index.html'."),
        error_document: z.string().optional().describe("Error document key, e.g. 'error.html'. Omit for none."),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, index_document, error_document }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(
          new PutBucketWebsiteCommand({
            Bucket: bucket,
            WebsiteConfiguration: { IndexDocument: { Suffix: index_document }, ErrorDocument: error_document ? { Key: error_document } : undefined },
          }),
        );
        return toolJsonResult({ bucket, index_document, error_document: error_document ?? null }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_website",
    {
      title: "Delete Scaleway bucket website configuration",
      description: "Remove the static-website configuration - the website endpoint stops serving.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketWebsiteCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Visibility (ACL) ----------
  server.registerTool(
    "scaleway_s3_get_bucket_visibility",
    {
      title: "Get Scaleway bucket visibility (public/private)",
      description:
        "Read a bucket's visibility, derived from its ACL grants: 'public' if the anonymous AllUsers group holds any grant, otherwise 'private'. Returns the raw grants too.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketAclCommand({ Bucket: bucket }));
        const grants = (res.Grants ?? []).map((g) => ({ grantee: g.Grantee?.URI ?? g.Grantee?.ID ?? null, permission: g.Permission }));
        const isPublic = grants.some((g) => g.grantee === ALL_USERS_URI);
        return toolJsonResult({ bucket, visibility: isPublic ? "public" : "private", grants }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_set_bucket_visibility",
    {
      title: "Set Scaleway bucket visibility (public/private)",
      description:
        "Set bucket visibility via canned ACL: 'public-read' grants the anonymous internet READ on ALL objects (the console's 'Public' setting) - requires confirm=true; 'private' restores owner-only access. Note Bucket Policies (scaleway_s3_put_bucket_policy) are the finer-grained mechanism - this tool is the coarse on/off switch.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        visibility: z.enum(["private", "public-read"]),
        confirm: confirmField.optional().describe("Required true when visibility=public-read."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, visibility, confirm }) =>
      handleS3(async () => {
        if (visibility === "public-read" && confirm !== true) {
          return toolError("Making a bucket public-read exposes ALL object content to the anonymous internet - requires confirm: true.") as never;
        }
        await getS3Client(config, region).send(new PutBucketAclCommand({ Bucket: bucket, ACL: visibility }));
        return toolJsonResult({ bucket, visibility }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Lifecycle ----------
  server.registerTool(
    "scaleway_s3_get_bucket_lifecycle",
    {
      title: "Get Scaleway bucket lifecycle rules",
      description:
        "Read a bucket's lifecycle rules. Errors with NoSuchLifecycleConfiguration if none are set. Each rule reports " +
        "prefix, expiration_days, noncurrent_expiration_days, abort_incomplete_multipart_days (each null when absent) " +
        "and transitions. Tag filters, noncurrent-version transitions and date-based expiration are NOT shown - a " +
        "get -> put round trip through these tools drops them.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
        const rules = (res.Rules ?? []).map((r) => ({
          id: r.ID,
          status: r.Status,
          // An empty Prefix is Scaleway's documented "all objects" filter - report it as null, the same as none.
          prefix: r.Filter?.Prefix || null,
          expiration_days: r.Expiration?.Days ?? null,
          noncurrent_expiration_days: r.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
          abort_incomplete_multipart_days: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
          transitions: (r.Transitions ?? []).map((t) => ({ days: t.Days, storage_class: t.StorageClass })),
        }));
        return toolJsonResult({ bucket, rules }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_lifecycle",
    {
      title: "Set Scaleway bucket lifecycle rules (full replace)",
      description:
        "Set a bucket's lifecycle rules. FULL-REPLACE: the provided list becomes the bucket's COMPLETE rule set and " +
        "every existing rule missing from it is REMOVED. A PUT carrying only an abort-incomplete-multipart rule " +
        "therefore DELETES an existing expiration rule, and that retention silently stops. To add or remove a single " +
        "rule, use scaleway_s3_add_lifecycle_rule / scaleway_s3_remove_lifecycle_rule (server-side merge). Every call " +
        "computes a rule-level diff against the current configuration (added/removed/changed/unchanged); pass " +
        "dry_run: true to see it without writing. " +
        "Each rule needs at least one action: expiration_days and noncurrent_expiration_days permanently DELETE data " +
        "once they take effect; transitions move objects to a colder Scaleway class (ONEZONE_IA, GLACIER); " +
        "abort_incomplete_multipart_days aborts multipart uploads still unfinished that many days after initiation " +
        "and deletes their parts, touching no committed object. " +
        "Requires confirm=true, with two exceptions: dry_run: true never writes, and when EVERY rule's only action is " +
        "abort_incomplete_multipart_days AND the bucket's current rules carry no other action either, nothing " +
        "committed can be deleted and no expiration/transition rule can be dropped, so confirm may be omitted.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        rules: z.array(lifecycleRuleSchema).min(1),
        dry_run: z
          .boolean()
          .default(false)
          .describe("true: compute and return the rule-level diff (added/removed/changed/unchanged vs the bucket's current rules) WITHOUT writing anything - no confirm needed."),
        confirm: confirmField
          .optional()
          .describe(
            "Must be explicitly true, unless every rule is abort-incomplete-multipart only and the bucket's current " +
              "rules are too (see the tool description), or dry_run is true.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, rules, confirm, dry_run }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const desired = rules.map(toSdkRule);
        const current = await currentLifecycleRules(client, bucket);
        // Diff is computed on EVERY call (#80): dry_run gets it without writing, a real PUT echoes it
        // so the caller sees exactly which rules it added, removed or rewrote.
        const diff = diffRules(current, desired);
        if (dry_run) {
          return toolJsonResult(
            { bucket, dry_run: true, nothing_written: true, diff, current_rule_count: current.length, requested_rule_count: rules.length },
            config.MAX_OUTPUT_CHARS,
          );
        }
        if (confirm !== true) {
          const gated = rules.filter((r) => !isAbortOnlyInput(r)).map((r) => r.id);
          if (gated.length > 0) {
            return toolError(
              `Requires confirm: true - rule(s) ${gated.join(", ")} carry an action other than ` +
                "abort_incomplete_multipart_days (expiration_days / noncurrent_expiration_days permanently DELETE " +
                "data; transitions move objects to a colder class). Only an abort-only rule set can skip confirm. " +
                "Pass dry_run: true to preview the diff without writing.",
            ) as never;
          }
          // Abort-only request: it still FULL-REPLACES, so refuse if it would drop a rule that expires or
          // transitions anything - the silent-drop trap #80 describes. Same read-first shape as put_object's
          // HEAD-before-overwrite check, with the same (accepted) window between the read and the write.
          const dropped = current
            .filter((r) => diff.removed.includes(r.ID ?? "(no id)") && !isAbortOnlyExisting(r))
            .map((r) => r.ID ?? "(no id)");
          if (dropped.length > 0) {
            return toolError(
              `Requires confirm: true - FULL-REPLACE: this PUT would REMOVE the bucket's existing rule(s) ` +
                `${dropped.join(", ")}, which carry actions other than aborting incomplete multipart uploads ` +
                "(expiration, noncurrent expiration or transitions - they would silently stop). To " +
                "keep them, read them with scaleway_s3_get_bucket_lifecycle, include them in 'rules' and pass " +
                "confirm: true, or use scaleway_s3_add_lifecycle_rule which merges. To drop them deliberately, pass confirm: true.",
            ) as never;
          }
        }
        await client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: { Rules: desired },
          }),
        );
        return toolJsonResult({ bucket, applied: rules.length, rules, diff }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Rule-level lifecycle edits (#80): merge instead of full-replace ----------
  server.registerTool(
    "scaleway_s3_add_lifecycle_rule",
    {
      title: "Add ONE lifecycle rule (server-side merge - existing rules are preserved)",
      description:
        "Server-side get -> append -> put: the bucket's current rules are kept and this one is added, so the full-replace " +
        "silent-drop trap (adding an abort-MPU rule and deleting the expiration rule with it) cannot happen. Refuses a " +
        "duplicate rule ID. confirm is required unless the NEW rule's only action is abort_incomplete_multipart_days - an " +
        "expiration rule starts deleting data once effective, so it always needs confirm. See scaleway_s3_put_bucket_lifecycle " +
        "for the rule fields.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        rule: lifecycleRuleSchema,
        confirm: confirmField.optional().describe("Required true unless the new rule is abort-incomplete-multipart only (nothing committed can be deleted by it)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, rule, confirm }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        // Read the CURRENT SDK rules and pass them back unchanged - any element this tool's input schema
        // does not model (tag filters, date-based expiration, ...) round-trips untouched.
        const current = await currentLifecycleRules(client, bucket);
        if (current.some((r) => (r.ID ?? "(no id)") === rule.id)) {
          return toolError(
            `A rule with ID '${rule.id}' already exists on ${bucket} (existing: ${current.map((r) => r.ID ?? "(no id)").join(", ") || "none"}). ` +
              "IDs must be unique - remove the old rule first (scaleway_s3_remove_lifecycle_rule) or pick another ID.",
          ) as never;
        }
        if (!isAbortOnlyInput(rule) && confirm !== true) {
          return toolError(
            `Requires confirm: true - rule '${rule.id}' carries an action other than abort_incomplete_multipart_days ` +
              "(expiration_days / noncurrent_expiration_days permanently DELETE data once effective; transitions move objects " +
              "to a colder class). An abort-only rule may be added without confirm.",
          ) as never;
        }
        const desired = [...current, toSdkRule(rule)];
        await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: desired } }));
        return toolJsonResult(
          { bucket, added: rule.id, rule_count: desired.length, diff: diffRules(current, desired) },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_remove_lifecycle_rule",
    {
      title: "Remove ONE lifecycle rule by ID (the rest are preserved)",
      description:
        "Server-side get -> filter -> put: only the named rule is removed. Refused when the bucket has no lifecycle config, when " +
        "no rule carries that ID (existing IDs are listed), or when it is the LAST rule (use scaleway_s3_delete_bucket_lifecycle, " +
        "which demands its own confirm). confirm is required unless the removed rule's only action is aborting incomplete multipart " +
        "uploads - removing an expiration rule changes retention, and objects that were due to expire keep living.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        id: z.string().min(1).describe("The rule ID to remove, from scaleway_s3_get_bucket_lifecycle."),
        confirm: confirmField.optional().describe("Required true unless the removed rule is abort-incomplete-multipart only (removing it cannot affect committed objects)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, id, confirm }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const current = await currentLifecycleRules(client, bucket);
        if (current.length === 0) {
          return toolError(`Bucket ${bucket} has no lifecycle configuration - nothing to remove.`) as never;
        }
        const target = current.find((r) => (r.ID ?? "(no id)") === id);
        if (!target) {
          return toolError(`No rule with ID '${id}' on ${bucket}. Existing: ${current.map((r) => r.ID ?? "(no id)").join(", ")}.`) as never;
        }
        const remaining = current.filter((r) => r !== target);
        if (remaining.length === 0) {
          return toolError(
            `Rule '${id}' is the bucket's ONLY rule. Removing it would leave an empty configuration - use ` +
              "scaleway_s3_delete_bucket_lifecycle instead (its confirm covers removing retention wholesale).",
          ) as never;
        }
        if (!isAbortOnlyExisting(target) && confirm !== true) {
          return toolError(
            `Requires confirm: true - rule '${id}' carries an action other than aborting incomplete multipart uploads; removing ` +
              "it changes retention (objects it would have expired keep living, or stop transitioning). An abort-only rule can be " +
              "removed without confirm.",
          ) as never;
        }
        await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: remaining } }));
        return toolJsonResult(
          { bucket, removed: id, remaining_ids: remaining.map((r) => r.ID ?? "(no id)"), diff: diffRules(current, remaining) },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_lifecycle",
    {
      title: "Delete Scaleway bucket lifecycle rules",
      description:
        "Remove ALL lifecycle rules. Requires confirm=true: objects that would have expired keep living (rule removal stops pending deletions - dangerous in the opposite direction of putting rules).",
      inputSchema: { bucket: bucketField, region: regionField, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Encryption ----------
  server.registerTool(
    "scaleway_s3_get_bucket_encryption",
    {
      title: "Get Scaleway bucket encryption config",
      description:
        "Read the bucket's S3 default-encryption configuration. A fresh bucket returns an EMPTY config (HTTP 200, not an error, unlike AWS which errors) rather than 'AES256 always on' - this is a REAL, toggleable setting, not inert metadata: live-verified 2026-08-18 via the console's Settings tab, put_bucket_encryption/delete_bucket_encryption visibly flip the bucket's 'Encryption type' there between 'Disabled' and 'SSE-ONE encryption with Scaleway Object Native Encryption keys'. (An earlier version of this description claimed the config was declarative-only with no effect - that was wrong, corrected after console cross-validation.)",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketEncryptionCommand({ Bucket: bucket }));
        const rules = (res.ServerSideEncryptionConfiguration?.Rules ?? []).map((r) => ({
          algorithm: r.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null,
        }));
        return toolJsonResult({ bucket, rules, note: "empty rules = encryption 'Disabled' in the console; a rule present = an active SSE default, confirmed to actually toggle the console's Encryption type setting" }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_encryption",
    {
      title: "Set Scaleway bucket encryption config",
      description:
        "Set the bucket's S3 default-encryption configuration (AES256). Live-verified 2026-08-18: this is a real setting, not S3-API-compatibility filler - the console's Settings tab shows 'Encryption type' flip from 'Disabled' to 'SSE-ONE encryption with Scaleway Object Native Encryption keys' immediately after this call.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        algorithm: z.literal("AES256").default("AES256"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, algorithm }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(
          new PutBucketEncryptionCommand({
            Bucket: bucket,
            ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: algorithm } }] },
          }),
        );
        return toolJsonResult({ bucket, algorithm }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_encryption",
    {
      title: "Delete Scaleway bucket encryption config",
      description:
        "Remove the bucket's default-encryption configuration. Requires confirm=true: live-verified 2026-08-18, " +
        "this reverts the console's 'Encryption type' back to 'Disabled' - a real security-posture downgrade (future " +
        "uploads that don't explicitly request SSE stop getting it by default), not a no-op on inert metadata.",
      inputSchema: { bucket: bucketField, region: regionField, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketEncryptionCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  // ---------- Object Lock ----------
  server.registerTool(
    "scaleway_s3_get_object_lock",
    {
      title: "Get Scaleway bucket object-lock configuration",
      description:
        "Read whether Object Lock (WORM protection) is enabled on the bucket. ObjectLockConfigurationNotFoundError means NOT enabled - there is no 'disabled' state, the config simply does not exist until first enabled.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
        return toolJsonResult(
          { bucket, object_lock_enabled: res.ObjectLockConfiguration?.ObjectLockEnabled ?? null },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_enable_object_lock",
    {
      title: "Enable Object Lock on a Scaleway bucket (ONE-WAY, irreversible)",
      description:
        "Enable Object Lock (WORM: object versions can never be deleted before their retention expires). IRREVERSIBLE: once enabled it can NEVER be disabled or removed - Scaleway rejects the disable request at the XML-schema level, and versioning becomes permanently frozen at Enabled (both live-verified 2026-08-18). Prerequisite: versioning must be Enabled first - pass enable_versioning_if_needed=true to let this tool do that, otherwise the API rejects with InvalidBucketState. Creating a bucket with object lock at creation time is NOT possible on Scaleway: the S3 CreateBucket flag ObjectLockEnabledForBucket is silently ignored (live-verified 2026-08-18) - this tool is the only working path. An empty locked bucket can still be deleted.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        enable_versioning_if_needed: z.boolean().default(false).describe("true: enable versioning first if not already Enabled. false (default): fail instructively if versioning is off."),
        confirm: confirmField.describe("Must be explicitly true - this is a one-way door for the bucket."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, enable_versioning_if_needed }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const cur = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
        let versioningWasEnabled = cur.Status === "Enabled";
        if (!versioningWasEnabled) {
          if (!enable_versioning_if_needed) {
            return toolError(
              "Versioning must be 'Enabled' before Object Lock can be enabled (API rejects with InvalidBucketState otherwise). " +
                "Re-run with enable_versioning_if_needed: true, or enable it via scaleway_s3_set_bucket_versioning.",
            ) as never;
          }
          await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
          versioningWasEnabled = true;
        }
        await client.send(new PutObjectLockConfigurationCommand({ Bucket: bucket, ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } }));
        return toolJsonResult(
          { bucket, object_lock_enabled: true, versioning_now: "Enabled", warning: "one-way: object lock can never be disabled on this bucket, and versioning can no longer be suspended" },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );
}
