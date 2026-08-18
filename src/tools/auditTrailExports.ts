import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { auditRequest } from "../auditClient.js";
import { toolJsonResult } from "../output.js";
import {
  auditRegionSchema,
  confirmSchema,
  handleAudit,
  maxPagesSchema,
  numberPaginate,
  WRITE_PERMISSIONS_NOTE,
} from "./auditTrailShared.js";

interface ExportJobS3Config {
  bucket: string;
  region: string;
  prefix?: string | null;
  project_id?: string | null;
}

interface ExportJob {
  id: string;
  organization_id: string;
  name: string;
  s3: ExportJobS3Config;
  created_at?: string | null;
  last_run_at?: string | null;
  tags?: string[];
  last_status?: { code?: string | null; message?: string | null } | null;
}

interface ListExportJobsResponse {
  export_jobs: ExportJob[];
  total_count: number;
}

const listSchema = {
  region: auditRegionSchema,
  name: z.string().optional().describe("Filter by exact export job name."),
  order_by: z.enum(["name_asc", "name_desc", "created_at_asc", "created_at_desc"]).optional().describe("Default name_asc."),
  max_pages: maxPagesSchema,
};

const createSchema = {
  region: auditRegionSchema,
  name: z.string().min(1).describe("Name of the export job."),
  bucket: z.string().min(1).describe("Object Storage bucket the audit events are shipped to. It must already exist - create it first (e.g. scaleway_s3_create_bucket)."),
  bucket_region: z.enum(["fr-par", "nl-ams", "pl-waw"]).optional().describe("Region of the destination bucket. Defaults to the server's configured region (fr-par)."),
  prefix: z.string().optional().describe("Key prefix inside the bucket to write under, e.g. 'audit-trail/'."),
  project_id: z.string().uuid().optional().describe("Project owning the destination bucket. Defaults to the server's configured Project."),
  tags: z.array(z.string()).optional().describe("Tags for the export job."),
};

const deleteSchema = {
  region: auditRegionSchema,
  export_job_id: z.string().uuid().describe("ID of the export job to delete - from scaleway_audit_list_export_jobs."),
  confirm: confirmSchema.describe("Must be explicitly true. Stops future exports; already-exported objects in the bucket are NOT deleted."),
};

export function registerAuditTrailExports(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_audit_list_export_jobs",
    {
      title: "List Scaleway Audit Trail export jobs",
      description:
        "List this Organization's Audit Trail export jobs - recurring jobs shipping audit events to an Object " +
          "Storage bucket (S3 destination config, last run, last status). The console's Audit Trail > Exports " +
          "page. " +
          WRITE_PERMISSIONS_NOTE,
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ region, name, order_by, max_pages }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const { items, total_count, truncated } = await numberPaginate<ExportJob>(
          async (page) => {
            const qp = new URLSearchParams({
              organization_id: config.SCW_ORGANIZATION_ID,
              page: String(page),
              page_size: "100",
              order_by: order_by ?? "name_asc",
            });
            if (name) qp.set("name", name);
            const data = await auditRequest<ListExportJobsResponse>(config, `/regions/${r}/export-jobs?${qp.toString()}`);
            return { items: data.export_jobs ?? [], total_count: data.total_count ?? 0 };
          },
          max_pages ?? 20,
        );
        return toolJsonResult({ total_count, count: items.length, truncated, export_jobs: items }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_create_export_job",
    {
      title: "Create a Scaleway Audit Trail export job",
      description:
        "Create an export job shipping Audit Trail events to an Object Storage bucket (S3 destination). The " +
          "bucket must already exist and be writable - create it first (e.g. scaleway_s3_create_bucket). " +
          "Live-verified 2026-08-18: creation triggers an IMMEDIATE backfill, not just a future cadence - a fresh " +
          "job wrote ~6 days of past daily log objects (one JSON file per day, e.g. '2026/07/12/logs_*.json') into " +
          "the bucket within seconds of creation. scaleway_audit_delete_export_job does not delete these - if you " +
          "created a bucket just to test this, you'll need to empty it (object-level operations are out of scope " +
          "for this server) before scaleway_s3_delete_bucket will succeed. Check last_run_at / last_status via " +
          "scaleway_audit_list_export_jobs afterwards for the ongoing cadence. " +
          WRITE_PERMISSIONS_NOTE,
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ region, name, bucket, bucket_region, prefix, project_id, tags }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        const job = await auditRequest<ExportJob>(config, `/regions/${r}/export-jobs`, {
          method: "POST",
          body: {
            organization_id: config.SCW_ORGANIZATION_ID,
            name,
            s3: {
              bucket,
              region: bucket_region ?? config.SCW_DEFAULT_REGION,
              prefix,
              project_id: project_id ?? config.SCW_PROJECT_ID,
            },
            tags,
          },
        });
        return toolJsonResult(job, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_audit_delete_export_job",
    {
      title: "Delete a Scaleway Audit Trail export job",
      description:
        "PERMANENTLY delete an export job by ID. Requires confirm=true. Stops future exports; objects already " +
          "written to the destination bucket are NOT deleted by this call. " +
          WRITE_PERMISSIONS_NOTE,
      inputSchema: deleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ region, export_job_id }) =>
      handleAudit(async () => {
        const r = region ?? config.SCW_DEFAULT_REGION;
        await auditRequest<void>(config, `/regions/${r}/export-jobs/${export_job_id}`, {
          method: "DELETE",
        });
        return toolJsonResult({ deleted: true, export_job_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
