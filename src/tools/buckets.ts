import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateBucketCommand, DeleteBucketCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult } from "../output.js";

const bucketField = z.string().min(3).describe("Bucket name, e.g. 'payments-backups'.");
const regionField = z.string().optional().describe("Region to operate in. Defaults to the server's configured region (fr-par).");

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
 * Bucket lifecycle only (create/list/delete) - deliberately minimal, matching this server's scope
 * of access-control management rather than general Object Storage administration. Visibility,
 * encryption, versioning, lifecycle rules, static website hosting, tags, and object-level operations
 * are all out of scope; use the console or scw CLI for those. This exists because Bucket Policies
 * (scaleway_s3_put_bucket_policy) require a bucket to already exist - without these three tools,
 * testing or provisioning a bucket policy meant leaving this server entirely.
 */
export function registerBuckets(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_create_bucket",
    {
      title: "Create Scaleway Object Storage bucket",
      description:
        "Create a new, empty Object Storage bucket, private by default. Minimal by design - this server manages " +
        "access control (Bucket Policies), not bucket configuration; for visibility, encryption, versioning, " +
        "lifecycle rules, or static website hosting, use the console or scw CLI after creating the bucket here.",
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
