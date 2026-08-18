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
} from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";

/**
 * Bucket-level configuration management (issue #7): tagging, CORS, versioning, website,
 * visibility (ACL), lifecycle rules, encryption config, and object lock. Behavior facts in the
 * descriptions below were live-verified against fr-par on 2026-08-18 with throwaway buckets -
 * see docs/gotchas.md for the probe evidence. Bucket logging and bucket metrics are NOT here:
 * Scaleway's S3 endpoint returns NotImplemented for both (live-verified 2026-08-18).
 */
const bucketField = z.string().min(3).describe("Bucket name.");
const regionField = z.string().optional().describe("Region to operate in. Defaults to the server's configured region (fr-par).");
const confirmField = z.literal(true).describe("Must be explicitly true.");

const ALL_USERS_URI = "http://acs.amazonaws.com/groups/global/AllUsers";

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
      }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_tagging",
    {
      title: "Set Scaleway bucket tags (full replace)",
      description:
        "Set a bucket's tags. FULL-REPLACE semantics: the provided list becomes the complete tag set - tags not in the list are removed.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        tags: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1).describe("The COMPLETE tag set to apply."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, tags }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(
          new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tags.map((t) => ({ Key: t.key, Value: t.value })) } }),
        );
        return toolJsonResult({ bucket, applied: tags.length, tags }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_tagging",
    {
      title: "Delete Scaleway bucket tags",
      description: "Remove ALL tags from a bucket. Requires confirm=true. Reversible in the sense that tags can be re-applied, but the current set is lost.",
      inputSchema: { bucket: bucketField, region: regionField, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }),
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
      }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_cors",
    {
      title: "Set Scaleway bucket CORS rules (full replace)",
      description:
        "Set a bucket's CORS rules. FULL-REPLACE semantics: the provided list becomes the complete rule set - existing rules not in the list are removed. This loosens or restricts browser cross-origin access to the bucket.",
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, rules }) =>
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
  );

  // ---------- Lifecycle ----------
  server.registerTool(
    "scaleway_s3_get_bucket_lifecycle",
    {
      title: "Get Scaleway bucket lifecycle rules",
      description: "Read a bucket's lifecycle rules. Errors with NoSuchLifecycleConfiguration if none are set.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
        const rules = (res.Rules ?? []).map((r) => ({
          id: r.ID,
          status: r.Status,
          prefix: r.Filter?.Prefix ?? null,
          expiration_days: r.Expiration?.Days ?? null,
          transitions: (r.Transitions ?? []).map((t) => ({ days: t.Days, storage_class: t.StorageClass })),
        }));
        return toolJsonResult({ bucket, rules }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_lifecycle",
    {
      title: "Set Scaleway bucket lifecycle rules (full replace)",
      description:
        "Set a bucket's lifecycle rules. FULL-REPLACE: the provided list becomes the complete rule set. DESTRUCTIVE: rules with expiration permanently DELETE matching objects once they take effect - requires confirm=true regardless of rule content. Rules apply to objects stored with Scaleway storage classes; transition targets Scaleway classes (ONEZONE_IA, GLACIER).",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        rules: z
          .array(
            z.object({
              id: z.string().min(1),
              enabled: z.boolean(),
              prefix: z.string().optional().describe("Rule applies only to keys under this prefix. Omit for all objects."),
              expiration_days: z.number().int().min(1).optional().describe("Permanently delete objects this many days after creation. Omit to keep."),
              transitions: z
                .array(z.object({ days: z.number().int().min(0), storage_class: z.enum(["ONEZONE_IA", "GLACIER"]) }))
                .optional()
                .describe("Move objects to a colder storage class after N days."),
            }),
          )
          .min(1),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, rules, }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: {
              Rules: rules.map((r) => ({
                ID: r.id,
                Status: r.enabled ? "Enabled" : "Disabled",
                Filter: r.prefix ? { Prefix: r.prefix } : undefined,
                Expiration: r.expiration_days ? { Days: r.expiration_days } : undefined,
                Transitions: r.transitions?.map((t) => ({ Days: t.days, StorageClass: t.storage_class })),
              })),
            },
          }),
        );
        return toolJsonResult({ bucket, applied: rules.length, rules }, config.MAX_OUTPUT_CHARS);
      }),
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
      }),
  );

  // ---------- Encryption (declarative config) ----------
  server.registerTool(
    "scaleway_s3_get_bucket_encryption",
    {
      title: "Get Scaleway bucket encryption config",
      description:
        "Read the bucket's S3 default-encryption configuration. IMPORTANT (live-verified 2026-08-18): Scaleway returns an EMPTY config (not an error) for buckets where none was ever set, and Scaleway encrypts all Object Storage at rest platform-side regardless - this config is declarative S3-API-compatibility metadata, not an on/off switch for actual encryption.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const res = await getS3Client(config, region).send(new GetBucketEncryptionCommand({ Bucket: bucket }));
        const rules = (res.ServerSideEncryptionConfiguration?.Rules ?? []).map((r) => ({
          algorithm: r.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null,
        }));
        return toolJsonResult({ bucket, rules, note: "empty rules = no declarative config set; at-rest encryption is always-on platform-side" }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_encryption",
    {
      title: "Set Scaleway bucket encryption config",
      description:
        "Set the bucket's S3 default-encryption declaration (AES256). See get_bucket_encryption: declarative metadata for S3-API compatibility - Scaleway encrypts at rest regardless. Useful mainly for tooling that expects an explicit config to exist.",
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
      }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_encryption",
    {
      title: "Delete Scaleway bucket encryption config",
      description:
        "Remove the bucket's declarative encryption config. Data stays encrypted at rest (platform-side, always-on) - this only removes the S3-API config object.",
      inputSchema: { bucket: bucketField, region: regionField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        await getS3Client(config, region).send(new DeleteBucketEncryptionCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }),
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
      }),
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
      }),
  );
}
