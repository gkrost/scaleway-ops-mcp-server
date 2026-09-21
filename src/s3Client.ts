import { S3Client, S3ServiceException, GetBucketPolicyCommand } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import { toolError } from "./output.js";
import { resolveOwnPrincipal } from "./ownPrincipal.js";
import { parseBucketPolicy, principalIds } from "./policyEval.js";

/**
 * One S3Client per region: bucket-policy calls go through the region-specific
 * S3-compatible endpoint (s3.<region>.scw.cloud), not api.scaleway.com - a
 * separate auth path (SigV4) from the IAM REST API's bearer token, even though
 * both use the same access/secret key pair.
 */
const clientsByRegion = new Map<string, S3Client>();

export function getS3Client(config: Config, region?: string): S3Client {
  const r = region ?? config.SCW_DEFAULT_REGION;
  let client = clientsByRegion.get(r);
  if (!client) {
    client = new S3Client({
      endpoint: `https://s3.${r}.scw.cloud`,
      region: r,
      credentials: {
        accessKeyId: config.SCW_ACCESS_KEY,
        secretAccessKey: config.SCW_SECRET_KEY,
      },
      forcePathStyle: false,
    });
    clientsByRegion.set(r, client);
  }
  return client;
}

/** Which bucket an S3 call operates on - lets a denial explain itself (#73). */
export interface BucketCallContext {
  config: Config;
  bucket: string;
  region?: string;
}

/**
 * On an AccessDenied against a bucket, read that bucket's policy (the server may read policies
 * even where object access is denied - observed live 2026-09-21) and say whether this server's own
 * principal is among the principals the policy grants to. Best-effort: every secondary failure in
 * here is swallowed and returns "" - the original denial must never be masked by the explainer.
 */
async function explainAccessDenied(ctx: BucketCallContext): Promise<string> {
  const parts: string[] = [];
  try {
    const own = await resolveOwnPrincipal(ctx.config);
    const who = own.application_id ? `application_id:${own.application_id}` : `access_key:${own.access_key}`;
    parts.push(`This call ran as ${who}.`);
  } catch {
    // Cannot resolve the own principal - still try the policy read below.
  }
  try {
    const client = getS3Client(ctx.config, ctx.region);
    const res = await client.send(new GetBucketPolicyCommand({ Bucket: ctx.bucket }));
    const policy = parseBucketPolicy(res.Policy ? JSON.parse(res.Policy) : null);
    const ids = principalIds(policy);
    if (ids.length === 0) {
      parts.push(`Bucket ${ctx.bucket} has a Bucket Policy with no principals in any statement.`);
    } else {
      const own = await resolveOwnPrincipal(ctx.config).catch(() => null);
      const ownAppId = own?.application_id ?? null;
      const listed = ownAppId ? ids.includes(`application_id:${ownAppId}`) : false;
      parts.push(
        `Bucket ${ctx.bucket} has a Bucket Policy granting to: ${ids.join(", ")} - ` +
          (listed ? `this server's principal IS listed, so the denial likely comes from the IAM layer (the principal's project-scope permission sets) or a Deny statement.` : `this server's principal is NOT listed, so the policy itself excludes it.`),
      );
    }
  } catch (err) {
    if (err instanceof S3ServiceException && err.name === "NoSuchBucketPolicy") {
      parts.push(`Bucket ${ctx.bucket} has NO Bucket Policy - the denial comes from the IAM layer alone (this server's own project-scope permission sets).`);
    } else if (err instanceof S3ServiceException && err.name === "AccessDenied") {
      parts.push(`The bucket's policy could not be read either (also AccessDenied).`);
    }
    // Anything else: skip the explanation silently.
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** Run an S3 call, converting S3ServiceException into a well-formed tool error result. Re-throws anything else.
 * Pass a BucketCallContext so an AccessDenied (#73) can explain itself against the bucket's policy. */
export async function handleS3<T>(
  fn: () => Promise<T>,
  ctx?: BucketCallContext,
): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof S3ServiceException) {
      let message = `Scaleway Object Storage error (${err.name}): ${err.message}`;
      if (err.name === "AccessDenied" && ctx) {
        message += await explainAccessDenied(ctx);
      }
      return toolError(message) as unknown as T;
    }
    throw err;
  }
}
