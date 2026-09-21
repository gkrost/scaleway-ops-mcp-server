/**
 * Bucket Policy parsing/evaluation shared by the access-denial explainer (#73) and the read-only
 * security audit (#81). Deliberately a heuristic evaluator: it answers "which statements of THIS
 * bucket's policy mention this principal/action", not a full IAM conformance engine - S3 decisions
 * also involve the principal's own IAM permission sets, which this file never sees.
 */

export interface PolicyStatement {
  sid: string | null;
  effect: string | null;
  /** Normalized principal ids: "application_id:<uuid>", "user_id:<uuid>", or "*". */
  principals: string[];
  /** Action patterns as written, e.g. "s3:GetObject", "s3:*". */
  actions: string[];
  /** Resource entries as written - bare bucket names or "bucket/*" (Scaleway uses no ARNs). */
  resources: string[];
}

export interface ParsedPolicy {
  version: string | null;
  statements: PolicyStatement[];
}

/** Parse an already-JSON-decoded bucket policy document. Tolerates missing/malformed fields. */
export function parseBucketPolicy(policy: unknown): ParsedPolicy {
  const out: ParsedPolicy = { version: null, statements: [] };
  if (!policy || typeof policy !== "object") return out;
  const doc = policy as Record<string, unknown>;
  if (typeof doc.Version === "string") out.version = doc.Version;
  const raw = Array.isArray(doc.Statement) ? doc.Statement : typeof doc.Statement === "object" && doc.Statement !== null ? [doc.Statement] : [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const st = s as Record<string, unknown>;
    out.statements.push({
      sid: typeof st.Sid === "string" ? st.Sid : null,
      effect: typeof st.Effect === "string" ? st.Effect : null,
      principals: normalizePrincipals(st.Principal),
      actions: normalizeStringList(st.Action),
      resources: normalizeStringList(st.Resource),
    });
  }
  return out;
}

function normalizeStringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Scaleway principals arrive as {"SCW": "application_id:<uuid>"} (string or array) or "*". */
function normalizePrincipals(p: unknown): string[] {
  if (p === "*") return ["*"];
  if (typeof p === "string") return [p];
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    for (const key of ["SCW", "AWS"]) {
      if (o[key] !== undefined) {
        const vals = normalizeStringList(o[key]);
        // A bare UUID principal means the bucket owner's own user - tag it so reports stay readable.
        return vals.map((v) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? `user_id:${v}` : v));
      }
    }
  }
  return [];
}

/** Case-insensitive match of an action pattern ("s3:Get*", "s3:*") against a concrete action. */
export function actionMatches(pattern: string, action: string): boolean {
  const p = pattern.toLowerCase();
  const a = action.toLowerCase();
  if (!p.includes("*")) return p === a;
  const re = new RegExp(`^${
    p
      .split("*")
      .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")
  }$`);
  return re.test(a);
}

/**
 * Object-level vs bucket-level action classification, by S3 naming convention: object ops end in
 * "Object", or operate on the parts of one object. ListMultipartUploads is a bucket-level call
 * despite the name - hence the explicit exclusion.
 */
export function isObjectAction(action: string): boolean {
  const a = action.toLowerCase();
  if (a === "s3:listmultipartuploads") return false;
  return (
    a.endsWith("object") ||
    a.endsWith("objectversion") ||
    ["s3:abortmultipartupload", "s3:completemultipartupload", "s3:createmultipartupload", "s3:listparts", "s3:uploadpart", "s3:uploadpartcopy"].includes(a)
  );
}

/** True when `resource` covers an object-level operation in `bucket` ("bucket/*"). */
export function resourceCoversObject(bucket: string, resource: string): boolean {
  return resource === `${bucket}/*`;
}

/** True when `resource` covers a bucket-level operation (the bare bucket name). */
export function resourceCoversBucket(bucket: string, resource: string): boolean {
  return resource === bucket;
}

export interface StatementMatch {
  sid: string | null;
  effect: string | null;
  /** Which dimension matched: the principal list, the action, the resource - for the report. */
  principalMatch: boolean;
  actionMatch: boolean;
  resourceMatch: boolean;
}

/** All statements of `policy` whose Principal list names `principalId` (or "*"). */
export function statementsForPrincipal(policy: ParsedPolicy, principalId: string): PolicyStatement[] {
  return policy.statements.filter((st) => st.principals.includes("*") || st.principals.includes(principalId));
}

export interface PolicyVerdict {
  verdict: "allowed" | "denied" | "no-matching-statement";
  /** Statements that matched the action AND resource, regardless of effect. */
  matched: StatementMatch[];
  note: string;
}

/**
 * Evaluate one concrete action against the bucket's parsed policy for a given principal. S3 is
 * default-deny: an explicit Deny wins, then any matching Allow, otherwise implicit deny. The IAM
 * layer (project-scope permission sets) must ALSO allow - noted in every verdict's note.
 */
export function evaluatePolicyAction(policy: ParsedPolicy, bucket: string, action: string, principalId: string): PolicyVerdict {
  const objectLevel = isObjectAction(action);
  const matched: StatementMatch[] = [];
  for (const st of policy.statements) {
    const principalMatch = st.principals.includes("*") || st.principals.includes(principalId);
    const actionMatch = st.actions.some((a) => actionMatches(a, action));
    const resourceMatch = st.resources.some((r) => (objectLevel ? resourceCoversObject(bucket, r) : resourceCoversBucket(bucket, r)));
    if (principalMatch && actionMatch && resourceMatch) {
      matched.push({ sid: st.sid, effect: st.effect, principalMatch, actionMatch, resourceMatch });
    }
  }
  const explicitDeny = matched.find((m) => (m.effect ?? "").toLowerCase() === "deny");
  if (explicitDeny) {
    return { verdict: "denied", matched, note: `explicitly DENIED by statement ${explicitDeny.sid ?? "(no Sid)"} - a Deny always wins.` };
  }
  const allow = matched.find((m) => (m.effect ?? "").toLowerCase() === "allow");
  if (allow) {
    return {
      verdict: "allowed",
      matched,
      note: `allowed by statement ${allow.sid ?? "(no Sid)"} - but a Bucket Policy Allow alone is not sufficient on Scaleway: the principal also needs a project-scope IAM permission set (e.g. ObjectStorageFullAccess).`,
    };
  }
  return {
    verdict: "no-matching-statement",
    matched,
    note:
      `no statement of this bucket's policy grants ${action} to this principal - S3 is default-deny, so the policy does not grant it. ` +
      "Access would have to come from the principal's IAM permission sets alone, which a Bucket Policy does not change.",
  };
}

/** "application_id:<uuid>" / "user_id:<uuid>" / "*" extracted for reporting. */
export function principalIds(policy: ParsedPolicy): string[] {
  const ids = new Set<string>();
  for (const st of policy.statements) for (const p of st.principals) ids.add(p);
  return [...ids];
}
