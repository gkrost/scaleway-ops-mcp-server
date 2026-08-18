import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import { toolError } from "./output.js";

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

/** Run an S3 call, converting S3ServiceException into a well-formed tool error result. Re-throws anything else. */
export async function handleS3<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof S3ServiceException) {
      return toolError(`Scaleway Object Storage error (${err.name}): ${err.message}`) as unknown as T;
    }
    throw err;
  }
}
