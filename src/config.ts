import { z } from "zod";

const configSchema = z.object({
  SCW_SECRET_KEY: z.string().min(1, "SCW_SECRET_KEY is required"),
  SCW_ACCESS_KEY: z.string().min(1, "SCW_ACCESS_KEY is required"),
  SCW_ORGANIZATION_ID: z.string().min(1, "SCW_ORGANIZATION_ID is required"),
  SCW_PROJECT_ID: z.string().min(1, "SCW_PROJECT_ID is required"),
  SCW_DEFAULT_REGION: z.string().default("fr-par"),
  MAX_OUTPUT_CHARS: z.coerce.number().int().min(1000).default(25000),
  // Base64 in a JSON tool call/result roughly quadruples wire size vs. raw bytes (encode + the
  // surrounding JSON string escaping), so this bounds the DECODED byte size, not the payload the
  // model actually sends. 5 MB decoded is a deliberately conservative single-part ceiling -
  // multipart upload is out of scope (issue #8), so this is the hard limit for scaleway_s3_put_object.
  MAX_PUT_OBJECT_BYTES: z.coerce.number().int().min(1).default(5_000_000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Configuration error:\n${issues}`);
    process.exit(1);
  }
  return result.data;
}
