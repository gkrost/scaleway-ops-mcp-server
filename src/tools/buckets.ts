import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateBucketCommand, DeleteBucketCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult } from "../output.js";
import { scwRegionSchema } from "../scwRegion.js";
import { scwBucketNameSchema } from "../scwBucket.js";

const bucketField = scwBucketNameSchema.describe("Bucket name, e.g. 'payments-backups'.");
const regionField = scwRegionSchema.optional().describe("Region to operate in. Defaults to the server's configured region (fr-par).");

const createSchema = {
  bucket: bucketField,
  region: regionField,
};

const listSchema = {
  region: regionField,
};

const deleteSchema = {
  bucket: bucketField,
  region: regionField,
  confirm: z
    .literal(true)
    .describe(
      "Must be explicitly true. The bucket must already be empty - Scaleway (like AWS S3) refuses to delete a " +
        "non-empty bucket; this tool does not delete objects for you. Deletion is immediate and irreversible, and " +
        "frees the name for anyone to reuse.",
    ),
};

/**
 * Bucket lifecycle only (create/list/delete). Configuration (visibility, versioning, object lock,
 * website, lifecycle rules, tags, CORS, encryption config) lives in bucketConfig.ts; Bucket
 * Policies in bucketPolicies.ts; object-data operations are issue #8. Note: S3 bucket logging and
 * bucket metrics have no tools - Scaleway's S3 endpoint returns NotImplemented for both
 * (live-verified 2026-08-18).
 */
export function registerBuckets(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_create_bucket",
    {
      title: "Create Scaleway Object Storage bucket",
      description:
        "Create a new, empty Object Storage bucket, private by default. Configure it afterwards with the " +
          "scaleway_s3_*_bucket_* config tools (visibility, versioning, tags, CORS, website, lifecycle, encryption). " +
          "Object Lock cannot be enabled at creation on Scaleway (the S3 create-time flag is silently ignored) - " +
          "enable versioning then scaleway_s3_enable_object_lock afterwards.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, region: region ?? config.SCW_DEFAULT_REGION, created: true }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_s3_list_buckets",
    {
      title: "List Scaleway Object Storage buckets",
      description: "List Object Storage buckets in one region (buckets are region-scoped on Scaleway, unlike AWS's account-wide bucket namespace).",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(new ListBucketsCommand({}));
        const buckets = (res.Buckets ?? []).map((b) => ({ name: b.Name, creation_date: b.CreationDate }));
        return toolJsonResult({ region: region ?? config.SCW_DEFAULT_REGION, count: buckets.length, buckets }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_s3_delete_bucket",
    {
      title: "Delete Scaleway Object Storage bucket",
      description: "PERMANENTLY delete an empty Object Storage bucket. Requires confirm=true. Fails if the bucket still contains objects.",
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
