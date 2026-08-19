import { z } from "zod";

/**
 * Scaleway Object Storage bucket names: 3–63 chars, DNS-like ([a-z0-9.-]).
 * Slash is forbidden because S3 CopySource treats everything before the first
 * `/` as the bucket — `fuzz-src/nested` would silently copy from bucket
 * `fuzz-src` with key prefix `nested/`.
 */
export const scwBucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
    "Bucket names must be 3–63 lowercase letters, digits, hyphens, or dots (no slash or uppercase)",
  );
