import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3ServiceException,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";
import { scwRegionSchema } from "../scwRegion.js";
import { scwBucketNameSchema } from "../scwBucket.js";

const bucketField = scwBucketNameSchema.describe("Bucket name, e.g. 'payments-backups'.");
const regionField = scwRegionSchema.optional().describe("Region the bucket lives in. Defaults to the server's configured region (fr-par).");
const keyField = z.string().min(1).describe("Object key (the full path within the bucket), e.g. 'invoices/2026-08/inv-001.pdf'.");

/** URI-encode each path segment of a key but keep the '/' separators literal - required by S3's CopySource format. */
function encodeKeyForCopySource(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** True if `buf` round-trips through utf8 decode/encode unchanged, i.e. it is valid UTF-8 text, not arbitrary binary. */
function isUtf8Text(buf: Buffer): boolean {
  return Buffer.compare(Buffer.from(buf.toString("utf8"), "utf8"), buf) === 0;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const stream = body as { transformToByteArray: () => Promise<Uint8Array> };
  return Buffer.from(await stream.transformToByteArray());
}

/** True if `key` already exists in `bucket` - a cheap HEAD, swallowing only the "not found" case. */
async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err instanceof S3ServiceException && err.name === "NotFound") return false;
    throw err;
  }
}

/** S3's single-request ceiling - same as a single PUT; above it a copy must go multipart (#75). */
const SINGLE_PART_COPY_MAX_BYTES = 5 * 1024 ** 3;
/** 512 MiB parts: 10,000 parts x 512 MiB = exactly S3's 5 TB object maximum, so no sizing math needed. */
const MULTIPART_COPY_PART_BYTES = 512 * 1024 ** 2;

/**
 * Server-side copy of one object, single-request below 5 GiB and a multipart copy
 * (CreateMultipartUpload -> ranged UploadPartCopy -> Complete) above it. On any failure after the
 * multipart upload was created, the upload is aborted so no billed parts are left behind.
 */
async function copyObjectServerSide(
  client: S3Client,
  sourceBucket: string,
  sourceKey: string,
  destBucket: string,
  destKey: string,
  sizeBytes: number | undefined,
): Promise<{ copy_mode: "single" | "multipart"; parts?: number; etag?: string }> {
  const copySource = `${sourceBucket}/${encodeKeyForCopySource(sourceKey)}`;
  if (sizeBytes === undefined || sizeBytes <= SINGLE_PART_COPY_MAX_BYTES) {
    const res = await client.send(new CopyObjectCommand({ Bucket: destBucket, Key: destKey, CopySource: copySource }));
    return { copy_mode: "single", etag: res.CopyObjectResult?.ETag };
  }
  const mpu = await client.send(new CreateMultipartUploadCommand({ Bucket: destBucket, Key: destKey }));
  const uploadId = mpu.UploadId;
  if (!uploadId) throw new Error("CreateMultipartUpload returned no UploadId");
  const parts: { PartNumber: number; ETag?: string }[] = [];
  try {
    const partCount = Math.ceil(sizeBytes / MULTIPART_COPY_PART_BYTES);
    for (let part = 1; part <= partCount; part++) {
      const start = (part - 1) * MULTIPART_COPY_PART_BYTES;
      const end = Math.min(part * MULTIPART_COPY_PART_BYTES, sizeBytes) - 1;
      const res = await client.send(
        new UploadPartCopyCommand({
          Bucket: destBucket,
          Key: destKey,
          UploadId: uploadId,
          PartNumber: part,
          CopySource: copySource,
          CopySourceRange: `bytes=${start}-${end}`,
        }),
      );
      parts.push({ PartNumber: part, ETag: res.CopyPartResult?.ETag });
    }
    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: destBucket,
        Key: destKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    return { copy_mode: "multipart", parts: partCount, etag: done.ETag };
  } catch (err) {
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: destBucket, Key: destKey, UploadId: uploadId }));
    } catch {
      // Abort failing must not mask the copy error that got us here.
    }
    throw err;
  }
}

const putObjectSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
  content: z
    .string()
    .min(1)
    .describe(
      "Object content. For text, pass it directly as UTF-8. For binary payloads, base64-encode first and set " +
        "encoding='base64'. Decoded size is capped (MAX_PUT_OBJECT_BYTES, default 5 MB) - multipart/large-file " +
        "upload is out of scope; use the console or scw CLI for anything larger.",
    ),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("How to interpret 'content' before uploading."),
  content_type: z.string().optional().describe("MIME type, e.g. 'application/pdf' or 'image/png'. Guessed by S3 as octet-stream if omitted."),
  confirm: z
    .literal(true)
    .optional()
    .describe(
      "Required true when an object already exists at this bucket/key: this call would overwrite it, and the prior " +
        "content is gone the same way scaleway_s3_delete_object's is (unless the bucket has versioning enabled, " +
        "which this server does not manage). Not required when writing a new key.",
    ),
};

const getObjectSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
};

const listObjectsSchema = {
  bucket: bucketField,
  region: regionField,
  prefix: z.string().optional().describe("Only return keys starting with this prefix, e.g. 'invoices/2026-08/'."),
  delimiter: z.string().optional().describe("Group keys sharing a prefix up to this delimiter (typically '/') into common_prefixes, like folders - matching keys are excluded from 'objects'."),
  limit: z.number().int().min(1).max(1000).default(1000).describe("Max keys to return in this page (S3 hard cap is 1000)."),
  continuation_token: z.string().optional().describe("From a previous call's next_continuation_token, to fetch the next page."),
};

const headObjectSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
};

const copyObjectSchema = {
  source_bucket: bucketField.describe("Bucket the object is copied FROM."),
  source_key: keyField.describe("Key of the object to copy."),
  dest_bucket: bucketField.describe("Bucket the object is copied TO. Same as source_bucket for a same-bucket copy (e.g. a rename)."),
  dest_key: keyField.describe("Key the copy is written to."),
  region: regionField.describe("Region both buckets live in. Cross-region copy is out of scope - source and destination must be in the same region."),
  confirm: z
    .literal(true)
    .optional()
    .describe(
      "Required true when an object already exists at dest_bucket/dest_key: this call would overwrite it, the same " +
        "class of loss as scaleway_s3_delete_object (unless the bucket has versioning enabled, which this server " +
        "does not manage). Not required when the destination key is new.",
    ),
};

const deleteObjectSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
  confirm: z.literal(true).describe("Must be explicitly true. Deletion is immediate and irreversible (unless the bucket has versioning enabled, which this server does not manage)."),
};

const deleteObjectsSchema = {
  bucket: bucketField,
  region: regionField,
  keys: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .describe("Explicit list of keys to delete (S3 hard cap 1000 per call). No prefix or wildcard form - list scaleway_s3_list_objects first if you need to delete 'everything under a prefix'."),
  confirm: z.literal(true).describe("Must be explicitly true. Deletion is immediate and irreversible for every key listed."),
};

const getObjectTagsSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
};

const putObjectTagsSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
  tags: z
    .record(z.string(), z.string())
    .describe(
      "Complete tag set as key/value pairs, e.g. {\"env\":\"prod\",\"owner\":\"billing\"}. This REPLACES the " +
        "object's entire tag set, it does not merge - call scaleway_s3_get_object_tags first if you need to keep " +
        "existing tags, same replace-not-merge semantics as scaleway_s3_put_bucket_policy.",
    ),
  confirm: z.literal(true).describe("Must be explicitly true. Replacement is immediate and does not merge (omitted tags are dropped)."),
};

const presignedUrlSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
  operation: z.enum(["get", "put"]).describe("'get' for a time-limited download URL, 'put' for a time-limited upload URL."),
  expires_in_seconds: z.number().int().min(60).max(604_800).default(3600).describe("URL validity window. S3's own hard ceiling is 7 days (604800s)."),
  content_type: z.string().optional().describe("For operation='put' only: constrains the presigned URL to uploads declaring this exact Content-Type."),
  confirm: z
    .literal(true)
    .optional()
    .describe(
      "Required true when operation='put'. Put hands back a time-limited unauthenticated write URL that anyone who holds it can use to overwrite the object for up to 7 days.",
    ),
};

const listMultipartUploadsSchema = {
  bucket: bucketField,
  region: regionField,
  prefix: z.string().optional().describe("Only return in-progress uploads whose key starts with this prefix."),
  include_parts: z
    .boolean()
    .default(false)
    .describe(
      "true: also call ListParts for each returned upload (bounded to the first 50) to report its part count and uploaded bytes. " +
        "That is one extra API call per upload - leave false for a cheap overview.",
    ),
  max_uploads: z.number().int().min(1).max(1000).default(100).describe("Max in-progress uploads to return per call."),
  key_marker: z.string().optional().describe("From a previous call's next_key_marker, to continue past the first page."),
  upload_id_marker: z.string().optional().describe("From a previous call's next_upload_id_marker (must accompany key_marker)."),
};

const abortMultipartUploadSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
  upload_id: z.string().min(1).describe("The UploadId of the in-progress multipart upload, from scaleway_s3_list_multipart_uploads."),
  confirm: z
    .literal(true)
    .describe(
      "Must be explicitly true. Aborts the upload and PERMANENTLY deletes every part uploaded so far. If an application is still writing this " +
        "upload, its next part-PUT fails and the upload cannot be resumed.",
    ),
};

export function registerObjects(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_put_object",
    {
      title: "Upload an object to Scaleway Object Storage",
      description:
        "Upload (or overwrite) a single object. Single-part only - see the 'content' field for the size ceiling and " +
        "the binary-payload encoding. Requires confirm=true when this would overwrite an existing key (checked with " +
        "a HEAD before writing) - a plain new-object upload needs no confirm.",
      inputSchema: putObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key, content, encoding, content_type, confirm }) => {
      const body = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      if (body.byteLength > config.MAX_PUT_OBJECT_BYTES) {
        return toolError(
          `Decoded content is ${body.byteLength} bytes, over the ${config.MAX_PUT_OBJECT_BYTES}-byte ceiling (MAX_PUT_OBJECT_BYTES). ` +
            "Multipart/large-file upload is out of scope for this server - use the console or scw CLI instead.",
        );
      }
      return handleS3(async () => {
        const client = getS3Client(config, region);
        const overwriting = await objectExists(client, bucket, key);
        if (overwriting && confirm !== true) {
          return toolError(
            `An object already exists at ${bucket}/${key} - this call would overwrite it. Requires confirm: true ` +
              "(same class of loss as scaleway_s3_delete_object, unless the bucket has versioning enabled, which " +
              "this server does not manage). Use scaleway_s3_head_object first if you want to inspect what's there.",
          ) as never;
        }
        const res = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: content_type }));
        return toolJsonResult(
          { bucket, key, region: region ?? config.SCW_DEFAULT_REGION, size_bytes: body.byteLength, etag: res.ETag, uploaded: true, overwritten: overwriting },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region });
    },
  );

  server.registerTool(
    "scaleway_s3_get_object",
    {
      title: "Download an object from Scaleway Object Storage",
      description:
        "Download a single object's content and metadata. Content is returned as UTF-8 text when it round-trips " +
        "cleanly as text, otherwise as base64 (see 'encoding' in the result). Decoded size is capped " +
        "(MAX_GET_OBJECT_BYTES, default 5 MB) - larger objects fail fast; use scaleway_s3_generate_presigned_url instead.",
      inputSchema: getObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const sizeBytes = head.ContentLength;
        if (sizeBytes === undefined) {
          return toolError(
            "Object size could not be determined. Use scaleway_s3_generate_presigned_url or scaleway_s3_head_object.",
          );
        }
        if (sizeBytes > config.MAX_GET_OBJECT_BYTES) {
          return toolError(
            `Object is ${sizeBytes} bytes, over the ${config.MAX_GET_OBJECT_BYTES}-byte ceiling (MAX_GET_OBJECT_BYTES). ` +
              "Use scaleway_s3_generate_presigned_url instead.",
          );
        }
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (res.ContentLength !== undefined && res.ContentLength > config.MAX_GET_OBJECT_BYTES) {
          const body = res.Body as { destroy?: () => void } | undefined;
          body?.destroy?.();
          return toolError(
            `Object is ${res.ContentLength} bytes, over the ${config.MAX_GET_OBJECT_BYTES}-byte ceiling (MAX_GET_OBJECT_BYTES). ` +
              "Use scaleway_s3_generate_presigned_url instead.",
          );
        }
        const buf = await bodyToBuffer(res.Body);
        const asText = isUtf8Text(buf);
        return toolJsonResult(
          {
            bucket,
            key,
            content: asText ? buf.toString("utf8") : buf.toString("base64"),
            encoding: asText ? "utf8" : "base64",
            content_type: res.ContentType,
            size_bytes: buf.byteLength,
            etag: res.ETag,
            last_modified: res.LastModified,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_list_objects",
    {
      title: "List objects in a Scaleway Object Storage bucket",
      description: "List object keys in a bucket, optionally scoped by prefix and grouped by delimiter (like folders). Paginated - pass the returned next_continuation_token to continue.",
      inputSchema: listObjectsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, prefix, delimiter, limit, continuation_token }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: delimiter,
            MaxKeys: limit,
            ContinuationToken: continuation_token,
          }),
        );
        const objects = (res.Contents ?? []).map((o) => ({ key: o.Key, size_bytes: o.Size, last_modified: o.LastModified, etag: o.ETag }));
        const commonPrefixes = (res.CommonPrefixes ?? []).map((p) => p.Prefix);
        return toolJsonResult(
          {
            bucket,
            region: region ?? config.SCW_DEFAULT_REGION,
            prefix: prefix ?? null,
            delimiter: delimiter ?? null,
            count: objects.length,
            objects,
            common_prefixes: commonPrefixes,
            is_truncated: res.IsTruncated ?? false,
            next_continuation_token: res.NextContinuationToken ?? null,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_head_object",
    {
      title: "Get object metadata without downloading its content",
      description: "Fetch an object's metadata (content-type, size, etag, last-modified, user metadata) without transferring its body. Cheaper than scaleway_s3_get_object when you don't need the content.",
      inputSchema: headObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return toolJsonResult(
          {
            bucket,
            key,
            content_type: res.ContentType,
            size_bytes: res.ContentLength,
            etag: res.ETag,
            last_modified: res.LastModified,
            metadata: res.Metadata ?? {},
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_copy_object",
    {
      title: "Copy an object within or across Scaleway Object Storage buckets",
      description:
        "Server-side copy of one object to a new bucket/key, without downloading and re-uploading. Copies over 5 GiB " +
        "(S3's single-request ceiling) go through a multipart copy automatically - ranged part copies, aborted (no " +
        "billed parts left) on failure. Source and destination must be in the same region. Requires confirm=true when " +
        "the destination key already exists (checked with a HEAD before copying) - copying to a new key needs no confirm. " +
        "For copying MANY objects, scaleway_s3_copy_prefix pages and skips existing keys for you.",
      inputSchema: copyObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ source_bucket, source_key, dest_bucket, dest_key, region, confirm }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const overwriting = await objectExists(client, dest_bucket, dest_key);
        if (overwriting && confirm !== true) {
          return toolError(
            `An object already exists at ${dest_bucket}/${dest_key} - this copy would overwrite it. Requires ` +
              "confirm: true (same class of loss as scaleway_s3_delete_object, unless the bucket has versioning " +
              "enabled, which this server does not manage). Use scaleway_s3_head_object first if you want to " +
              "inspect what's there.",
          ) as never;
        }
        // Source HEAD is free metadata here (already needed for the overwrite check pattern) and decides
        // the copy path: single request up to 5 GiB, multipart copy above it (#75).
        const srcHead = await client.send(new HeadObjectCommand({ Bucket: source_bucket, Key: source_key }));
        const copy = await copyObjectServerSide(client, source_bucket, source_key, dest_bucket, dest_key, srcHead.ContentLength);
        return toolJsonResult(
          {
            source_bucket,
            source_key,
            dest_bucket,
            dest_key,
            region: region ?? config.SCW_DEFAULT_REGION,
            size_bytes: srcHead.ContentLength,
            copy_mode: copy.copy_mode,
            parts: copy.parts ?? null,
            etag: copy.etag,
            copied: true,
            overwritten: overwriting,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket: dest_bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_copy_prefix",
    {
      title: "Server-side copy of all objects under a prefix to another bucket (dry-run by default)",
      description:
        "Bucket-to-bucket copy with 'rclone copy --ignore-existing' semantics, server-side: pages both listings, copies the " +
        "objects missing from the destination, and reports copied / skipped_existing / failed. DRY RUN BY DEFAULT - without " +
        "dry_run=false it only reports what WOULD be copied (count, bytes, sample keys). Copies >5 GiB go multipart " +
        "automatically. Bounded per call by max_objects; if the source listing has more, the result carries a " +
        "continuation_token to resume. Source and destination must be in the same region. NOTE on access: one server-side " +
        "copy needs a single principal with read on the source AND write on the destination - with per-stage Bucket " +
        "Policies that principal only exists after an explicit grant (scaleway_s3_grant_temporary_access).",
      inputSchema: {
        source_bucket: bucketField.describe("Bucket the objects are copied FROM."),
        dest_bucket: bucketField.describe("Bucket the objects are copied TO."),
        region: regionField.describe("Region both buckets live in. Cross-region copy is out of scope."),
        prefix: z.string().optional().describe("Only copy source keys starting with this prefix."),
        ignore_existing: z
          .boolean()
          .default(true)
          .describe("true (default): skip keys that already exist in the destination, never overwriting. false: overwrite differing keys - requires confirm."),
        dry_run: z.boolean().default(true).describe("true (default): report what would be copied without writing anything."),
        max_objects: z.number().int().min(1).max(10_000).default(1000).describe("Max objects COPIED per call (skipped ones don't count). Resume past the cap with continuation_token."),
        continuation_token: z.string().optional().describe("From a previous call's continuation_token, to resume the source listing past the max_objects cap."),
        confirm: z.literal(true).optional().describe("Required true only when dry_run=false AND ignore_existing=false (that combination can overwrite destination objects)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ source_bucket, dest_bucket, region, prefix, ignore_existing, dry_run, max_objects, continuation_token, confirm }) =>
      handleS3(async () => {
        if (!dry_run && !ignore_existing && confirm !== true) {
          return toolError(
            "ignore_existing=false allows OVERWRITING destination objects - requires confirm: true. Keep ignore_existing=true " +
              "(the default) for skip-existing sync semantics, or dry_run: true to preview.",
          ) as never;
        }
        const client = getS3Client(config, region);
        // Snapshot the destination keys once (ignore-existing needs the full set to skip against).
        const existingKeys = new Set<string>();
        if (ignore_existing) {
          let destToken: string | undefined;
          do {
            const destPage = await client.send(new ListObjectsV2Command({ Bucket: dest_bucket, Prefix: prefix, ContinuationToken: destToken, MaxKeys: 1000 }));
            for (const o of destPage.Contents ?? []) if (o.Key) existingKeys.add(o.Key);
            destToken = destPage.IsTruncated ? destPage.NextContinuationToken : undefined;
          } while (destToken);
        }
        const copied: string[] = [];
        const skipped: string[] = [];
        const failed: { key: string; error: string }[] = [];
        let copiedBytes = 0;
        let wouldCopyCount = 0;
        let wouldCopyBytes = 0;
        const sample: string[] = [];
        let sourceToken = continuation_token;
        let exhausted = true;
        do {
          const page = await client.send(new ListObjectsV2Command({ Bucket: source_bucket, Prefix: prefix, ContinuationToken: sourceToken, MaxKeys: 1000 }));
          for (const o of page.Contents ?? []) {
            const key = o.Key;
            if (!key) continue;
            if (ignore_existing && existingKeys.has(key)) {
              skipped.push(key);
              continue;
            }
            if (copied.length + failed.length >= max_objects) {
              exhausted = false;
              break;
            }
            if (dry_run) {
              wouldCopyCount += 1;
              wouldCopyBytes += o.Size ?? 0;
              if (sample.length < 20) sample.push(key);
              continue;
            }
            try {
              await copyObjectServerSide(client, source_bucket, key, dest_bucket, key, o.Size);
              copied.push(key);
              copiedBytes += o.Size ?? 0;
            } catch (err) {
              failed.push({ key, error: err instanceof Error ? err.message : String(err) });
              if (failed.length >= 25) {
                exhausted = false;
                break;
              }
            }
          }
          sourceToken = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (!exhausted) break;
        } while (sourceToken);
        return toolJsonResult(
          {
            source_bucket,
            dest_bucket,
            prefix: prefix ?? null,
            dry_run,
            ignore_existing,
            dry_run_summary: dry_run ? { would_copy: wouldCopyCount, would_copy_bytes: wouldCopyBytes, sample_keys: sample } : undefined,
            copied: dry_run ? undefined : copied,
            copied_count: dry_run ? 0 : copied.length,
            copied_bytes: dry_run ? 0 : copiedBytes,
            skipped_existing_count: skipped.length,
            failed: dry_run ? undefined : failed,
            failed_count: dry_run ? 0 : failed.length,
            source_fully_scanned: exhausted,
            continuation_token: exhausted ? null : sourceToken ?? null,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket: dest_bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_object",
    {
      title: "Delete a single object from Scaleway Object Storage",
      description: "PERMANENTLY delete one object. Requires confirm=true.",
      inputSchema: deleteObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return toolJsonResult({ bucket, key, deleted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_delete_objects",
    {
      title: "Batch-delete objects from Scaleway Object Storage",
      description: "PERMANENTLY delete up to 1000 explicitly-named objects in one call. Requires confirm=true. No prefix/wildcard form - never wipes a bucket recursively.",
      inputSchema: deleteObjectsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, keys }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false } }),
        );
        return toolJsonResult(
          {
            bucket,
            requested: keys.length,
            deleted: (res.Deleted ?? []).map((d) => d.Key),
            errors: (res.Errors ?? []).map((e) => ({ key: e.Key, code: e.Code, message: e.Message })),
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_get_object_tags",
    {
      title: "Get an object's tags",
      description: "Read the key/value tag set attached to an object.",
      inputSchema: getObjectTagsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
        const tags = Object.fromEntries((res.TagSet ?? []).map((t) => [t.Key, t.Value]));
        return toolJsonResult({ bucket, key, tags }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_put_object_tags",
    {
      title: "Set an object's tags",
      description: "Replace an object's entire tag set. This REPLACES, it does not merge - see the 'tags' field. Requires confirm=true.",
      inputSchema: putObjectTagsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key, tags, confirm }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(
          new PutObjectTaggingCommand({
            Bucket: bucket,
            Key: key,
            Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
          }),
        );
        return toolJsonResult({ bucket, key, tags, updated: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_generate_presigned_url",
    {
      title: "Generate a time-limited presigned URL for an object",
      description:
        "Generate a URL that grants direct GET or PUT access to one object for a limited time, without exposing this server's credential. " +
        "Useful for handing a download/upload link to something outside MCP, or for content too large for scaleway_s3_get_object/put_object's inline transfer. " +
        "operation='put' requires confirm=true because it exports a write capability outside the MCP boundary.",
      inputSchema: presignedUrlSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region, key, operation, expires_in_seconds, content_type, confirm }) =>
      handleS3(async () => {
        if (operation === "put" && confirm !== true) {
          return toolError(
            "Generating a presigned PUT URL requires confirm: true (it hands back a time-limited unauthenticated write URL usable outside the MCP boundary).",
          ) as never;
        }
        const client = getS3Client(config, region);
        const command =
          operation === "get"
            ? new GetObjectCommand({ Bucket: bucket, Key: key })
            : new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: content_type });
        const url = await getSignedUrl(client, command, { expiresIn: expires_in_seconds });
        return toolJsonResult(
          { bucket, key, operation, url, expires_in_seconds, expires_at: new Date(Date.now() + expires_in_seconds * 1000).toISOString() },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  // ---------- Incomplete multipart uploads (#78): parts you pay for that no object listing shows ----------
  server.registerTool(
    "scaleway_s3_list_multipart_uploads",
    {
      title: "List incomplete multipart uploads in a bucket (billed, invisible parts)",
      description:
        "Read-only. List multipart uploads still in progress - each holds uploaded parts you pay storage for that NO object listing " +
        "shows and no lifecycle rule touches unless one aborts incomplete uploads. With include_parts=true, also reports part count and " +
        "uploaded bytes per upload (one extra ListParts call per upload, bounded to the first 50). Paginated via key_marker/upload_id_marker.",
      inputSchema: listMultipartUploadsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, prefix, include_parts, max_uploads, key_marker, upload_id_marker }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: prefix,
            MaxUploads: max_uploads,
            KeyMarker: key_marker,
            UploadIdMarker: upload_id_marker,
          }),
        );
        const uploads = (res.Uploads ?? []).map((u) => ({
          key: u.Key,
          upload_id: u.UploadId,
          initiated: u.Initiated,
          storage_class: u.StorageClass ?? null,
          parts: null as number | null,
          bytes_uploaded: null as number | null,
          last_part_number: null as number | null,
        }));
        if (include_parts) {
          for (const u of uploads.slice(0, 50)) {
            try {
              const parts = await client.send(new ListPartsCommand({ Bucket: bucket, Key: u.key, UploadId: u.upload_id }));
              const list = parts.Parts ?? [];
              u.parts = list.length;
              u.bytes_uploaded = list.reduce((sum, p) => sum + (p.Size ?? 0), 0);
              u.last_part_number = list.length > 0 ? (list[list.length - 1].PartNumber ?? null) : null;
            } catch {
              // ListParts can 404 if the upload completed/was aborted between the two calls - report the overview entry without part detail.
              u.parts = null;
              u.bytes_uploaded = null;
            }
          }
        }
        return toolJsonResult(
          {
            bucket,
            count: uploads.length,
            uploads,
            is_truncated: res.IsTruncated ?? false,
            next_key_marker: res.IsTruncated ? (res.NextKeyMarker ?? res.KeyMarker ?? null) : null,
            next_upload_id_marker: res.IsTruncated ? (res.NextUploadIdMarker ?? res.UploadIdMarker ?? null) : null,
            note: include_parts
              ? "part counts cover at most the first 50 uploads; rerun with include_parts=true after paging if you need the rest"
              : "include_parts=false: no part counts - set it true to fetch part count and uploaded bytes per upload",
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_abort_multipart_upload",
    {
      title: "Abort an incomplete multipart upload (deletes its uploaded parts)",
      description:
        "Abort one in-progress multipart upload, PERMANENTLY deleting every part uploaded so far and stopping the storage billing for it. " +
        "Requires confirm=true. Find upload ids with scaleway_s3_list_multipart_uploads first. A lifecycle rule with " +
        "abort_incomplete_multipart_days (scaleway_s3_add_lifecycle_rule) prevents the accumulation in the first place.",
      inputSchema: abortMultipartUploadSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key, upload_id }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: upload_id }));
        return toolJsonResult({ bucket, key, upload_id, aborted: true }, config.MAX_OUTPUT_CHARS);
      }, { config, bucket, region }),
  );
}
