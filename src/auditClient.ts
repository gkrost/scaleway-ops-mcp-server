import type { Config } from "./config.js";

const AUDIT_TRAIL_BASE_URL = "https://api.scaleway.com/audit-trail/v1alpha1";

export class AuditTrailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(formatAuditErrorBody(status, body));
    this.name = "AuditTrailApiError";
  }
}

/** Error envelope not yet confirmed to match IAM's details[] shape - kept deliberately plain. */
function formatAuditErrorBody(status: number, body: unknown): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string") {
    return `Scaleway Audit Trail API error (HTTP ${status}): ${(body as Record<string, unknown>).message}`;
  }
  return `Scaleway Audit Trail API error (HTTP ${status})`;
}

export async function auditRequest<T>(
  config: Config,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = "GET", body } = options;
  const headers: Record<string, string> = { "X-Auth-Token": config.SCW_SECRET_KEY };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${AUDIT_TRAIL_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    throw new AuditTrailApiError(res.status, parsed);
  }
  return parsed as T;
}
