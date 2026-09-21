import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeleteBucketPolicyCommand, GetBucketPolicyCommand, ListBucketsCommand, PutBucketPolicyCommand, S3ServiceException } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { getS3Client, handleS3 } from "../s3Client.js";
import { toolJsonResult, toolError } from "../output.js";
import { iamRequest } from "../iamClient.js";
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

// ---------- Statement-level helpers (#77): add/remove/grant/sweep do read-modify-write server-side ----------
// Same (accepted) read-then-write race window as put_object's overwrite check and the lifecycle
// abort gate - Scaleway's GetBucketPolicy exposes no ETag to precondition the PUT on.

interface PolicyDoc {
  Version?: string;
  Statement?: unknown[];
  [k: string]: unknown;
}

/** The bucket's current policy document, or null when it has none (NoSuchBucketPolicy). */
async function readPolicyDoc(client: S3Client, bucket: string): Promise<PolicyDoc | null> {
  try {
    const res = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    return res.Policy ? (JSON.parse(res.Policy) as PolicyDoc) : null;
  } catch (err) {
    if (err instanceof S3ServiceException && err.name === "NoSuchBucketPolicy") return null;
    throw err;
  }
}

async function putPolicyDoc(client: S3Client, bucket: string, doc: PolicyDoc): Promise<void> {
  await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(doc) }));
}

/**
 * Caller-side principals arrive in Scaleway's own id vocabulary: 'application_id:<uuid>',
 * 'user_id:<uuid>' or '*'. Bare UUIDs are taken as user ids. Wire shape is Scaleway's documented
 * {"SCW": "<id>"} - except "*", which must be the bare string.
 */
function wirePrincipal(p: string | string[]): unknown {
  const list = (Array.isArray(p) ? p : [p]).map((v) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? `user_id:${v}` : v));
  if (list.length === 1 && list[0] === "*") return "*";
  return { SCW: Array.isArray(p) ? list : list[0] };
}

/** Instructive client-side validation for the known Scaleway policy gotchas - fires before any API call. */
function validateStatementParts(sid: string, actions: string[], resources: string[]): string | null {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sid)) {
    return `Sid '${sid}' is not valid - use 1-128 characters of letters, digits or hyphens (e.g. 'GrantDevReadOnly').`;
  }
  const badAction = actions.find((a) => a === "s3:HeadObject" || !/^s3:[A-Za-z*?]+$/.test(a));
  if (badAction) {
    if (badAction === "s3:HeadObject") {
      return "'s3:HeadObject' is NOT a valid action on Scaleway (HeadObject calls are authorized via 's3:GetObject') - submitting it fails with 'Policy has invalid action'.";
    }
    return `Action '${badAction}' does not look like an S3 action - expected the form 's3:GetObject' (wildcards like 's3:*' are allowed).`;
  }
  const badResource = resources.find((r) => r.startsWith("arn:"));
  if (badResource) {
    return `Resource '${badResource}' is an ARN - Scaleway bucket policies take BARE bucket names ('my-bucket', 'my-bucket/*'), not ARNs ('Policy has invalid resource', confirmed empirically 2026-08-18).`;
  }
  return null;
}

const statementSchema = z.object({
  sid: z.string().min(1).max(128).describe("Statement Sid - unique within this policy. Refused if a statement with this Sid already exists."),
  effect: z.enum(["Allow", "Deny"]),
  principal: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe(
      "'application_id:<uuid>' or 'user_id:<uuid>' (a bare UUID is taken as user_id), or '*' for anonymous - " +
        "a string or a list. Sent as Scaleway's {\"SCW\": ...} wire shape.",
    ),
  action: z.array(z.string().min(1)).min(1).describe("S3 actions, e.g. [\"s3:GetObject\", \"s3:ListBucket\"]. NOT 's3:HeadObject' (invalid on Scaleway)."),
  resource: z.array(z.string().min(1)).min(1).describe("BARE bucket names / 'bucket/*' - NOT ARNs."),
});

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
      }, { config, bucket, region }),
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
      }, { config, bucket, region });
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
      }, { config, bucket, region }),
  );

  // ---------- Statement-level edits and temporary grants (#77) ----------
  server.registerTool(
    "scaleway_s3_add_bucket_policy_statement",
    {
      title: "Add one statement to a Scaleway Bucket Policy (merge, not replace)",
      description:
        "Server-side read-modify-write: GET the bucket's policy, refuse a duplicate Sid, append this statement, PUT the merged " +
        "document. Existing statements are preserved - unlike scaleway_s3_put_bucket_policy, which is FULL-REPLACE and can " +
        "silently revoke grants when a caller omits them. No confirm needed: this only ever ADDS access; removing it again is " +
        "scaleway_s3_remove_bucket_policy_statement. Remember the IAM half: the principal also needs a project-scope permission " +
        "set (scaleway_iam_create_policy) for a grant to take effect.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        statement: statementSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, statement }) => {
      const invalid = validateStatementParts(statement.sid, statement.action, statement.resource);
      if (invalid) return toolError(invalid);
      return handleS3(async () => {
        const client = getS3Client(config, region);
        const doc = await readPolicyDoc(client, bucket);
        const statements = Array.isArray(doc?.Statement) ? (doc!.Statement as unknown[]) : [];
        if (statements.some((s) => (s as { Sid?: string })?.Sid === statement.sid)) {
          return toolError(
            `A statement with Sid '${statement.sid}' already exists on ${bucket} - refusing to add a duplicate. Read the policy ` +
              "with scaleway_s3_get_bucket_policy, remove the old statement with scaleway_s3_remove_bucket_policy_statement, or pick a different Sid.",
          ) as never;
        }
        const newStatement = {
          Sid: statement.sid,
          Effect: statement.effect,
          Principal: wirePrincipal(statement.principal),
          Action: statement.action,
          Resource: statement.resource,
        };
        await putPolicyDoc(client, bucket, {
          Version: doc?.Version ?? "2023-04-17",
          Statement: [...statements, newStatement],
        });
        return toolJsonResult(
          { bucket, added: newStatement, statement_count: statements.length + 1, note: "read-modify-write server-side; a concurrent policy edit between the read and the PUT is lost (no ETag precondition on Scaleway)" },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region });
    },
  );

  server.registerTool(
    "scaleway_s3_remove_bucket_policy_statement",
    {
      title: "Remove one statement from a Scaleway Bucket Policy by Sid",
      description:
        "Server-side read-modify-write: GET the policy, drop the statement with this Sid, PUT the remainder. Requires confirm=true - " +
        "revoking a grant breaks whatever principal relied on it, immediately. Refused if no statement with that Sid exists (existing " +
        "Sids are listed). Removing the LAST statement is refused: an empty policy is meaningless - use scaleway_s3_delete_bucket_policy " +
        "instead, which requires its own confirm.",
      inputSchema: {
        bucket: bucketField,
        region: regionField,
        sid: z.string().min(1).describe("The Sid of the statement to remove, from scaleway_s3_get_bucket_policy."),
        confirm: z.literal(true).describe("Must be explicitly true - the named principal loses the statement's access immediately."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, sid }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const doc = await readPolicyDoc(client, bucket);
        if (!doc || !Array.isArray(doc.Statement)) {
          return toolError(`Bucket ${bucket} has no Bucket Policy - nothing to remove.`) as never;
        }
        const statements = doc.Statement as unknown[];
        const existingSids = statements.map((s) => (s as { Sid?: string })?.Sid).filter((s): s is string => typeof s === "string");
        const remaining = statements.filter((s) => (s as { Sid?: string })?.Sid !== sid);
        if (remaining.length === statements.length) {
          return toolError(
            `No statement with Sid '${sid}' on ${bucket}. Existing Sids: ${existingSids.length > 0 ? existingSids.join(", ") : "(none - statements without Sid cannot be removed this way; use put_bucket_policy for a full replace)"}.`,
          ) as never;
        }
        if (remaining.length === 0) {
          return toolError(
            `Sid '${sid}' is the ONLY statement in ${bucket}'s policy. Removing it would leave an empty policy - use ` +
              "scaleway_s3_delete_bucket_policy instead (its confirm covers removing the entire policy).",
          ) as never;
        }
        await putPolicyDoc(client, bucket, { ...doc, Statement: remaining });
        return toolJsonResult(
          { bucket, removed_sid: sid, remaining_sids: remaining.map((s) => (s as { Sid?: string })?.Sid ?? null), note: "read-modify-write server-side; a concurrent policy edit between the read and the PUT is lost (no ETag precondition on Scaleway)" },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region }),
  );

  server.registerTool(
    "scaleway_s3_grant_temporary_access",
    {
      title: "Grant a temporary bucket-policy grant that a sweep can later revoke",
      description:
        "Add a temporary Allow statement for one application: Sid is minted as '<sid_prefix><epoch-seconds>-<random>' encoding the " +
        "expiry, so scaleway_s3_revoke_expired_grants can find and remove it once lapsed. Bucket policies have NO native expiry - " +
        "a 'temporary' grant outlives its key unless something revokes it; this is that mechanism. Default sid_prefix='tmp-' is what " +
        "the sweep matches; use a prefix starting with 'tmp-' if you override it, or the grant will never be swept. Pair with an API " +
        "key that has its own expires_at (scaleway_iam_create_api_key).",
      inputSchema: {
        application_id: z.string().uuid(),
        bucket: bucketField,
        region: regionField,
        action: z.array(z.string().min(1)).min(1).describe("S3 actions to grant, e.g. [\"s3:GetObject\", \"s3:ListBucket\"] for read-only."),
        expires_at: z.string().datetime().describe("RFC3339 timestamp AFTER which the grant may be swept, e.g. '2026-09-22T00:00:00Z'. Must be in the future."),
        sid_prefix: z
          .string()
          .regex(/^[A-Za-z0-9-]{0,100}$/)
          .default("tmp-")
          .describe("Sid prefix; keep the default 'tmp-' (or something starting with it) so the expiry sweep recognizes the statement."),
        resource_prefix: z
          .string()
          .optional()
          .describe("Narrow the grant to keys under this prefix - statement Resource becomes '<bucket>/<prefix>*'. Omit for the whole bucket."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ application_id, bucket, region, action, expires_at, sid_prefix, resource_prefix }) => {
      const expiryMs = Date.parse(expires_at);
      if (expiryMs <= Date.now() + 60_000) {
        return toolError(`expires_at (${expires_at}) is not in the future - a grant that is born expired only adds confusion.`);
      }
      const sid = `${sid_prefix}${Math.floor(expiryMs / 1000)}-${randomBytes(2).toString("hex")}`;
      const invalid = validateStatementParts(sid, action, [bucket, resource_prefix ? `${bucket}/${resource_prefix}*` : `${bucket}/*`]);
      if (invalid) return toolError(invalid);
      return handleS3(async () => {
        // Fail fast on a typo'd application_id: Scaleway's PUT accepts unresolvable principals silently, producing a grant that can never work.
        try {
          await iamRequest<{ id: string }>(config, "GET", `/applications/${application_id}`);
        } catch (err) {
          return toolError(
            `application_id ${application_id} could not be resolved (${err instanceof Error ? err.message : String(err)}). ` +
              "List applications with scaleway_iam_list_applications first - granting to a non-existent principal would silently never take effect.",
          ) as never;
        }
        const client = getS3Client(config, region);
        const doc = await readPolicyDoc(client, bucket);
        const statements = Array.isArray(doc?.Statement) ? (doc!.Statement as unknown[]) : [];
        if (statements.some((s) => (s as { Sid?: string })?.Sid === sid)) {
          return toolError(`Sid collision on '${sid}' - rerun, the random suffix will differ.`) as never;
        }
        const newStatement = {
          Sid: sid,
          Effect: "Allow",
          Principal: { SCW: `application_id:${application_id}` },
          Action: action,
          Resource: [bucket, resource_prefix ? `${bucket}/${resource_prefix}*` : `${bucket}/*`],
        };
        await putPolicyDoc(client, bucket, { Version: doc?.Version ?? "2023-04-17", Statement: [...statements, newStatement] });
        return toolJsonResult(
          {
            bucket,
            application_id,
            sid,
            expires_at,
            action,
            resource: newStatement.Resource,
            revoke_with: "scaleway_s3_revoke_expired_grants removes this automatically once expires_at has passed",
            reminder: "a Bucket Policy is only half the grant - the application also needs a project-scope IAM permission set to act on it",
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, { config, bucket, region });
    },
  );

  server.registerTool(
    "scaleway_s3_revoke_expired_grants",
    {
      title: "Sweep expired temporary grants (Sid-encoded 'tmp-<epoch>-...' statements) from bucket policies",
      description:
        "Without confirm: read-only preview of which tmp-* statements in which buckets have an expiry encoded in their Sid " +
        "('tmp-<epoch-seconds>-<random>', as minted by scaleway_s3_grant_temporary_access) that has already passed. With " +
        "confirm=true: removes them. Sweeps every bucket in the region when bucket is omitted. Statements minted with a sid_prefix " +
        "not starting with 'tmp-' are invisible to this sweep.",
      inputSchema: {
        bucket: bucketField.optional().describe("Sweep just this bucket. Omit to sweep every bucket in the region."),
        region: regionField,
        confirm: z.literal(true).optional().describe("Required true to actually remove expired statements; omit for a read-only preview."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ bucket, region, confirm }) =>
      handleS3(async () => {
        const client = getS3Client(config, region);
        const buckets = bucket ? [bucket] : (await client.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name ?? "").filter((n) => n !== "") ?? [];
        const nowSec = Math.floor(Date.now() / 1000);
        const expiredByBucket: { bucket: string; sids: string[] }[] = [];
        const unreadable: { bucket: string; reason: string }[] = [];
        let revoked = false;
        for (const b of buckets) {
          let doc: PolicyDoc | null;
          try {
            doc = await readPolicyDoc(client, b);
          } catch (err) {
            unreadable.push({ bucket: b, reason: err instanceof Error ? err.message : String(err) });
            continue;
          }
          if (!doc || !Array.isArray(doc.Statement)) continue;
          const statements = doc.Statement as unknown[];
          const isExpiredTmp = (s: unknown): boolean => {
            const sid = (s as { Sid?: string })?.Sid;
            const m = typeof sid === "string" ? /^tmp-(\d{10,12})-[0-9a-f]+$/.exec(sid) : null;
            return m !== null && Number(m[1]) < nowSec;
          };
          const expired = statements.filter(isExpiredTmp).map((s) => (s as { Sid: string }).Sid);
          if (expired.length === 0) continue;
          expiredByBucket.push({ bucket: b, sids: expired });
          if (confirm === true) {
            await putPolicyDoc(client, b, { ...doc, Statement: statements.filter((s) => !isExpiredTmp(s)) });
            revoked = true;
          }
        }
        return toolJsonResult(
          {
            buckets_scanned: buckets.length,
            expired_grants: expiredByBucket,
            expired_statement_count: expiredByBucket.reduce((n, e) => n + e.sids.length, 0),
            revoked,
            policies_unreadable: unreadable,
            note: confirm === true ? "expired statements removed" : "preview only - rerun with confirm: true to remove these statements",
          },
          config.MAX_OUTPUT_CHARS,
        );
      }, bucket ? { config, bucket, region } : undefined),
  );
}
