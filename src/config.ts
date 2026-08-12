import { z } from "zod";

const configSchema = z.object({
  SCW_SECRET_KEY: z.string().min(1, "SCW_SECRET_KEY is required"),
  SCW_ACCESS_KEY: z.string().min(1, "SCW_ACCESS_KEY is required"),
  SCW_ORGANIZATION_ID: z.string().min(1, "SCW_ORGANIZATION_ID is required"),
  SCW_PROJECT_ID: z.string().min(1, "SCW_PROJECT_ID is required"),
  SCW_DEFAULT_REGION: z.string().default("fr-par"),
  MAX_OUTPUT_CHARS: z.coerce.number().int().min(1000).default(25000),
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
