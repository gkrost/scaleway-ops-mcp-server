import type { Config } from "./config.js";
import { iamRequest } from "./iamClient.js";

/**
 * Which identity THIS server's own operating credential (SCW_ACCESS_KEY) belongs to. Explaining
 * access denials (#73) and auditing this org's keys (#81) both need to know which application_id
 * the server itself runs as - the same lookup the self-delete guards in tools/applications.ts do.
 */
export interface OwnPrincipal {
  access_key: string;
  application_id: string | null;
  user_id: string | null;
  /** null = never expires. #81 flags this as a finding. */
  expires_at: string | null;
}

/** Canonical policy principal for an API key. User-owned keys are not applications. */
export function ownPrincipalId(principal: OwnPrincipal): string {
  if (principal.application_id) return `application_id:${principal.application_id}`;
  if (principal.user_id) return `user_id:${principal.user_id}`;
  // This should not normally be needed, but preserves a useful identity when IAM returns neither owner field.
  return `access_key:${principal.access_key}`;
}

interface ApiKeyShape {
  application_id?: string;
  user_id?: string;
  expires_at?: string;
}

let cache: { accessKey: string; principal: OwnPrincipal } | null = null;

/**
 * Resolve the credential this server authenticates as. Cached per access key - a process runs with
 * one credential for its whole lifetime (config is read once at startup), so the cache never goes
 * stale within a process.
 */
export async function resolveOwnPrincipal(config: Config): Promise<OwnPrincipal> {
  if (cache && cache.accessKey === config.SCW_ACCESS_KEY) return cache.principal;
  const key = await iamRequest<ApiKeyShape>(config, "GET", `/api-keys/${config.SCW_ACCESS_KEY}`);
  const principal: OwnPrincipal = {
    access_key: config.SCW_ACCESS_KEY,
    application_id: key.application_id ?? null,
    user_id: key.user_id ?? null,
    expires_at: key.expires_at ?? null,
  };
  cache = { accessKey: config.SCW_ACCESS_KEY, principal };
  return principal;
}
