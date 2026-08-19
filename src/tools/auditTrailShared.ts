import { z } from "zod";
import type { Config } from "../config.js";
import { AuditTrailApiError } from "../auditClient.js";
import { toolError } from "../output.js";
import { scwRegionSchema } from "../scwRegion.js";

export const auditRegionSchema = scwRegionSchema
  .optional()
  .describe("Defaults to the server's configured region (fr-par).");

export const recordedAfterSchema = z
  .string()
  .optional()
  .describe("ISO 8601 date-time, inclusive. Defaults to 24 hours ago.");

export const recordedBeforeSchema = z
  .string()
  .optional()
  .describe("ISO 8601 date-time, exclusive. Defaults to now (omitted from the request).");

export const maxPagesSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe("Safety cap on pagination (100 items/page). Default 20. Said to be truncated in the response if more pages remained.");

export const confirmSchema = z
  .literal(true)
  .describe("Must be explicitly true. Guards a destructive or implicitly-disabling operation.");

export const WRITE_PERMISSIONS_NOTE =
  "Needs more than AuditTrailReadOnly on THIS server's own credential (read-only covers just the " +
  "query tools) - if the call fails with permissions_denied, grant the Audit Trail write permission " +
  "set via scaleway_iam_set_policy_rules.";

export async function handleAudit<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuditTrailApiError) return toolError(err.message) as unknown as T;
    throw err;
  }
}

export function defaultRecordedAfter(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export interface AuditResource {
  type: string;
  id: string;
  name?: string | null;
}

export function trimResource(r: AuditResource): AuditResource {
  const out: AuditResource = { type: r.type, id: r.id };
  if (r.name) out.name = r.name;
  return out;
}

export interface ApiAuditEvent {
  id: string;
  recorded_at: string | null;
  principal: { id: string };
  organization_id: string;
  project_id?: string | null;
  source_ip: string;
  user_agent?: string | null;
  product_name: string;
  service_name: string;
  method_name: string;
  resources: AuditResource[];
  request_id: string;
  request_body?: unknown;
  status_code: number;
}

export function compactApiEvent(e: ApiAuditEvent): ApiAuditEvent {
  return {
    id: e.id,
    recorded_at: e.recorded_at,
    principal: e.principal,
    product_name: e.product_name,
    service_name: e.service_name,
    method_name: e.method_name,
    resources: (e.resources ?? []).map(trimResource),
    status_code: e.status_code,
  } as ApiAuditEvent;
}

export interface AuthAuditEvent {
  id: string;
  recorded_at: string | null;
  organization_id: string;
  source_ip: string;
  user_agent?: string | null;
  resources: AuditResource[];
  result?: string | null;
  failure_reason?: string | null;
  country_code?: string | null;
  method?: string | null;
  origin?: string | null;
  mfa_type?: string | null;
}

export function compactAuthEvent(e: AuthAuditEvent): AuthAuditEvent {
  return {
    id: e.id,
    recorded_at: e.recorded_at,
    source_ip: e.source_ip,
    result: e.result,
    failure_reason: e.failure_reason,
    country_code: e.country_code,
    method: e.method,
    origin: e.origin,
    mfa_type: e.mfa_type,
    resources: (e.resources ?? []).map(trimResource),
  } as AuthAuditEvent;
}

export interface SystemAuditEvent {
  id: string;
  recorded_at: string | null;
  locality?: string | null;
  organization_id: string;
  project_id?: string | null;
  product_name: string;
  source: string;
  system_name: string;
  resources: AuditResource[];
  kind?: string | null;
}

export function compactSystemEvent(e: SystemAuditEvent): SystemAuditEvent {
  return {
    id: e.id,
    recorded_at: e.recorded_at,
    product_name: e.product_name,
    source: e.source,
    system_name: e.system_name,
    kind: e.kind,
    resources: (e.resources ?? []).map(trimResource),
  } as SystemAuditEvent;
}

export interface CombinedAuditEvent {
  api?: ApiAuditEvent;
  auth?: AuthAuditEvent;
  system?: SystemAuditEvent;
}

export function compactCombinedEvent(e: CombinedAuditEvent): { kind: string; event: unknown } {
  if (e.api) return { kind: "api", event: compactApiEvent(e.api) };
  if (e.auth) return { kind: "auth", event: compactAuthEvent(e.auth) };
  if (e.system) return { kind: "system", event: compactSystemEvent(e.system) };
  return { kind: "unknown", event: e };
}

interface CursorPageResponse<T> {
  items: T[];
  next_page_token?: string | null;
}

export async function cursorPaginate<T>(
  fetchPage: (pageToken: string | undefined) => Promise<CursorPageResponse<T>>,
  maxPages: number,
): Promise<{ items: T[]; truncated: boolean; nextPageToken: string | null }> {
  const items: T[] = [];
  let token: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const { items: batch, next_page_token } = await fetchPage(token);
    items.push(...batch);
    if (!next_page_token) {
      token = undefined;
      break;
    }
    token = next_page_token;
    if (page === maxPages - 1) truncated = true;
  }
  return { items, truncated, nextPageToken: token ?? null };
}

interface NumberedPageResponse<T> {
  items: T[];
  total_count: number;
}

export async function numberPaginate<T>(
  fetchPage: (page: number) => Promise<NumberedPageResponse<T>>,
  maxPages: number,
): Promise<{ items: T[]; total_count: number; truncated: boolean }> {
  const items: T[] = [];
  let totalCount = 0;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    totalCount = res.total_count;
    items.push(...res.items);
    if (res.items.length === 0 || items.length >= res.total_count) {
      return { items, total_count: res.total_count, truncated: false };
    }
  }
  return { items, total_count: totalCount, truncated: items.length < totalCount };
}
