import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeleteBucketPolicyCommand, GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";
import { scwRegionSchema } from "../scwRegion.js";
import { scwBucketNameSchema } from "../scwBucket.js";

const bucketField = scwBucketNameSchema.describe("Bucket name, e.g. 'payments-backups'.");
const regionField = scwRegionSchema.optional().describe("Region the bucket lives in. Defaults to the server's configured region (fr-par).");

const getSchema = {
  bucket: bucketField,
  region: regionField,
};

const putSchema = {
  bucket: bucketField,
  region: regionField,
  policy_json: z
    .string()
    .min(1)
    .describe(
      "The COMPLETE bucket policy document as a JSON string (not a JS object) - this call REPLACES the entire " +
        "existing policy, it does not merge. To add a statement without losing existing grants, call " +
        "scaleway_s3_get_bucket_policy first, add your statement to its Statement array, then PUT the merged " +
        "document. Known gotcha: 's3:HeadObject' is NOT a valid action here (HeadObject/HeadBucket calls are " +
        "authorized via 's3:GetObject'/'s3:ListBucket' respectively) - submitting it fails with 'Policy has " +
        "invalid action'. Despite the AWS-compatible API/SDK, 'Resource' entries are BARE bucket names, NOT ARNs - " +
        "use 'my-bucket' and 'my-bucket/*', not 'arn:aws:s3:::my-bucket' (submitting an ARN fails with 'Policy has " +
        "invalid resource', confirmed empirically 2026-08-18). To grant an application_id Principal, 'Version' " +
        "must be '2023-04-17' (not AWS's '2012-10-17') - example: {\"Version\":\"2023-04-17\",\"Statement\":[{" +
        "\"Sid\":\"Example\",\"Effect\":\"Allow\",\"Principal\":{\"SCW\":\"application_id:<uuid>\"}," +
        "\"Action\":[\"s3:GetObject\",\"s3:ListBucket\"],\"Resource\":[\"my-bucket\",\"my-bucket/*\"]}]}. Also " +
        "remember an IAM Policy (scaleway_iam_create_policy) granting the SAME principal project-wide access to " +
        "the relevant permission sets is required in addition to this bucket policy - a Bucket Policy alone is " +
        "not sufficient on Scaleway.",
    ),
  confirm: z
    .literal(true)
    .describe(
      "Must be explicitly true. This replaces the entire bucket policy - a document granting Principal * or " +
        "omitting the caller's own access takes effect immediately.",
    ),
};

const deleteSchema = {
  bucket: bucketField,
  region: regionField,
  confirm: z.literal(true).describe("Must be explicitly true. Removes ALL grants this bucket policy provided - anyone relying on it loses access immediately."),
};

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function registerBucketPolicies(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_get_bucket_policy",
    {
      title: "Get Scaleway Bucket Policy",
      description: "Read the current Bucket Policy JSON attached to an Object Storage bucket. Returns an error if the bucket has no policy.",
      inputSchema: getSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const res = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        const policy = res.Policy ? JSON.parse(res.Policy) : null;
        return toolJsonResult({ bucket, policy }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_s3_put_bucket_policy",
    {
      title: "Set Scaleway Bucket Policy",
      description:
        "Replace a bucket's entire Bucket Policy with the given JSON document. Requires confirm=true. This is the bucket-scoped half of " +
        "access control - see scaleway_iam_create_policy's description for why both an IAM Policy and a Bucket " +
        "Policy are needed together. Recommended safety net: include a statement granting the bucket owner's own " +
        "user_id full access (mirrors the console's 'Maintain access to bucket' checkbox) so a mistake here can " +
        "never lock the account out of its own bucket.",
      inputSchema: putSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, policy_json, confirm }) => {
      if (!isValidJson(policy_json)) {
        return toolError("policy_json is not valid JSON - check for a missing/extra brace or comma before sending.");
      }
      return handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy_json }));
        return toolJsonResult({ bucket, updated: true }, config.MAX_OUTPUT_CHARS);
      });
    },
  );

  server.registerTool(
    "scaleway_s3_delete_bucket_policy",
    {
      title: "Delete Scaleway Bucket Policy",
      description: "Remove a bucket's Bucket Policy entirely. Requires confirm=true. Any principal relying only on this policy loses access to the bucket immediately.",
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        await client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
        return toolJsonResult({ bucket, deleted: true }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
