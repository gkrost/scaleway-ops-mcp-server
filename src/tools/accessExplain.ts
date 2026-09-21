import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetBucketPolicyCommand } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";
import { ownPrincipalId, resolveOwnPrincipal } from "../ownPrincipal.js";
import { evaluatePolicyAction, parseBucketPolicy } from "../policyEval.js";
import { scwRegionSchema } from "../scwRegion.js";
import { scwBucketNameSchema } from "../scwBucket.js";

const bucketField = scwBucketNameSchema.describe("Bucket name, e.g. 'payments-backups'.");
const regionField = scwRegionSchema.optional().describe("Region the bucket lives in. Defaults to the server's configured region (fr-par).");

/**
 * Read-only access explanation (#73): an AccessDenied used to be a bare "Access Denied" even though
 * the server could read the very Bucket Policy that explained it. This tool resolves this server's
 * own Application, evaluates one action against the bucket's policy statements, and names the Sid
 * that allows or denies - so a denial is a conclusion, not a four-call investigation.
 */
export function registerAccessExplain(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_s3_explain_access",
    {
      title: "Explain this server's access to a bucket action",
      description:
        "Evaluate one S3 action (e.g. 's3:GetObject', 's3:ListBucket', 's3:PutObject') against a bucket's Bucket " +
        "Policy for THIS server's own principal (resolved from its own operating credential). Returns allowed / " +
        "denied / no-matching-statement, and by which statement Sid. Read-only. Note: a Bucket Policy is only half " +
        "of Scaleway's two-layer model - the principal's IAM permission sets (project-scope ObjectStorage*) must " +
        "also allow, which this tool reports as a note, not a verdict.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        action: z
          .string()
          .min(1)
          .describe("The S3 action to evaluate, e.g. 's3:GetObject'. Wildcard patterns in the policy ('s3:Get*', 's3:*') are matched case-insensitively."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, action }) =>
      handleS3(async () => {
        const normalized = action.startsWith("s3:") ? action : `s3:${action}`;
        let own;
        try {
          own = await resolveOwnPrincipal(config);
        } catch (err) {
          return toolError(
            `Could not resolve this server's own principal from its operating credential (IAM GET /api-keys failed: ${err instanceof Error ? err.message : String(err)}).`,
          );
        }
        const ownPrincipal = ownPrincipalId(own);
        const client = getS3Client(config, region);
        let policyJson: string | null = null;
        try {
          const res = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
          policyJson = res.Policy ?? null;
        } catch {
          // get_bucket_policy is the dedicated tool for surfacing Scaleway's own error shapes.
          return toolError(
            `The Bucket Policy on ${bucket} could not be read - without it there is nothing to explain. ` +
              "Use scaleway_s3_get_bucket_policy to see the API's own error (NoSuchBucketPolicy means access is decided by the IAM layer alone).",
          );
        }
        const policy = parseBucketPolicy(policyJson ? JSON.parse(policyJson) : null);
        const verdict = evaluatePolicyAction(policy, bucket, normalized, ownPrincipal);
        return toolJsonResult(
          {
            bucket,
            action: normalized,
            this_server_principal: ownPrincipal,
            policy_version: policy.version,
            statement_count: policy.statements.length,
            verdict: verdict.verdict,
            matched_statements: verdict.matched,
            note: verdict.note,
            two_layer_model:
              "Scaleway allows an action only when BOTH the bucket's Bucket Policy AND the principal's IAM permission sets allow it. This tool evaluates only the Bucket Policy half.",
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );
}
