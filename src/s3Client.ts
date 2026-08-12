import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";

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
