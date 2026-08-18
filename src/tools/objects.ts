import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";

const bucketField = z.string().min(3).describe("Bucket name, e.g. 'payments-backups'.");
const regionField = z.string().optional().describe("Region the bucket lives in. Defaults to the server's configured region (fr-par).");
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
};

const presignedUrlSchema = {
  bucket: bucketField,
  region: regionField,
  key: keyField,
  operation: z.enum(["get", "put"]).describe("'get' for a time-limited download URL, 'put' for a time-limited upload URL."),
  expires_in_seconds: z.number().int().min(60).max(604_800).default(3600).describe("URL validity window. S3's own hard ceiling is 7 days (604800s)."),
  content_type: z.string().optional().describe("For operation='put' only: constrains the presigned URL to uploads declaring this exact Content-Type."),
};

export function registerObjects(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_put_object",
    {
      title: "Upload an object to Scaleway Object Storage",
      description: "Upload (or overwrite) a single object. Single-part only - see the 'content' field for the size ceiling and the binary-payload encoding.",
      inputSchema: putObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key, content, encoding, content_type }) => {
      const body = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      if (body.byteLength > config.MAX_PUT_OBJECT_BYTES) {
        return toolError(
          `Decoded content is ${body.byteLength} bytes, over the ${config.MAX_PUT_OBJECT_BYTES}-byte ceiling (MAX_PUT_OBJECT_BYTES). ` +
            "Multipart/large-file upload is out of scope for this server - use the console or scw CLI instead.",
        );
      }
      return handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: content_type }));
        return toolJsonResult(
          { bucket, key, region: region ?? config.SCW_DEFAULT_REGION, size_bytes: body.byteLength, etag: res.ETag, uploaded: true },
          config.MAX_OUTPUT_CHARS,
        );
      });
    },
  );

  server.registerTool(
    "scaleway_s3_get_object",
    {
      title: "Download an object from Scaleway Object Storage",
      description:
        "Download a single object's content and metadata. Content is returned as UTF-8 text when it round-trips " +
        "cleanly as text, otherwise as base64 (see 'encoding' in the result). Like every tool in this server, the " +
        "result is truncated to MAX_OUTPUT_CHARS - for large objects, use scaleway_s3_generate_presigned_url instead.",
      inputSchema: getObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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
      }),
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
      }),
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
      }),
  );

  server.registerTool(
    "scaleway_s3_copy_object",
    {
      title: "Copy an object within or across Scaleway Object Storage buckets",
      description: "Server-side copy of one object to a new bucket/key, without downloading and re-uploading. Source and destination must be in the same region.",
      inputSchema: copyObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ source_bucket, source_key, dest_bucket, dest_key, region }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(
          new CopyObjectCommand({
            Bucket: dest_bucket,
            Key: dest_key,
            CopySource: `${source_bucket}/${encodeKeyForCopySource(source_key)}`,
          }),
        );
        return toolJsonResult(
          {
            source_bucket,
            source_key,
            dest_bucket,
            dest_key,
            region: region ?? config.SCW_DEFAULT_REGION,
            etag: res.CopyObjectResult?.ETag,
            copied: true,
          },
          config.MAX_OUTPUT_CHARS,
        );
      }),
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
      }),
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
      }),
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
      }),
  );

  server.registerTool(
    "scaleway_s3_put_object_tags",
    {
      title: "Set an object's tags",
      description: "Replace an object's entire tag set. This REPLACES, it does not merge - see the 'tags' field.",
      inputSchema: putObjectTagsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, key, tags }) =>
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
      }),
  );

  server.registerTool(
    "scaleway_s3_generate_presigned_url",
    {
      title: "Generate a time-limited presigned URL for an object",
      description:
        "Generate a URL that grants direct GET or PUT access to one object for a limited time, without exposing this server's credential. " +
        "Useful for handing a download/upload link to something outside MCP, or for content too large for scaleway_s3_get_object/put_object's inline transfer.",
      inputSchema: presignedUrlSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region, key, operation, expires_in_seconds, content_type }) =>
      handleS3(async () => {
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
      }),
  );
}
