// Manual dev utility: spawns the built server over stdio and exercises real read/write/error
// paths against the LIVE Scaleway account using the credential in this repo's own .env.
// Not automated CI (needs live, privileged credentials) - run by hand from the repo root:
//   node scripts/smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path) {
  const vals = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const idx = t.indexOf("=");
    vals[t.slice(0, idx)] = t.slice(idx + 1);
  }
  return vals;
}

const creds = loadEnv(join(repoRoot, ".env"));

const transport = new StdioClientTransport({
  command: "node",
  args: [join(repoRoot, "dist/index.js")],
  env: {
    SCW_ACCESS_KEY: creds.SCW_ACCESS_KEY,
    SCW_SECRET_KEY: creds.SCW_SECRET_KEY,
    SCW_ORGANIZATION_ID: creds.SCW_ORGANIZATION_ID,
    SCW_PROJECT_ID: creds.SCW_PROJECT_ID,
  },
});

const client = new Client({ name: "smoke-test-client", version: "0.0.1" });
await client.connect(transport);

function text(res) {
  return res.content[0].text;
}

/** Parse a tool result as JSON, or abort loudly if the tool returned an error. */
function expectJson(res, label) {
  if (res.isError) {
    console.error(`FAILED at "${label}": ${text(res)}`);
    process.exit(1);
  }
  return JSON.parse(text(res));
}

console.log("=== scaleway_iam_list_api_keys (filter: scaleway-ops app) ===");
const apps = await client.callTool({ name: "scaleway_iam_list_applications", arguments: { name_filter: "scaleway-ops" } });
const appId = expectJson(apps, "list_applications").applications[0].id;
const keys = await client.callTool({ name: "scaleway_iam_list_api_keys", arguments: { application_id: appId } });
console.log(text(keys).slice(0, 400));

console.log("\n=== scaleway_iam_list_policies (filter: scaleway-ops app) ===");
const policies = await client.callTool({ name: "scaleway_iam_list_policies", arguments: { application_id: appId } });
console.log(text(policies).slice(0, 600));

console.log("\n=== WRITE PATH: create -> get -> delete a throwaway Application ===");
// Unique name per run: Scaleway's name-uniqueness check appears to lag briefly behind a DELETE
// (a create-with-same-name moments after deleting one 409'd here even though a GET already 404'd).
const throwawayName = `mcp-smoke-test-throwaway-${Date.now()}`;
const created = await client.callTool({
  name: "scaleway_iam_create_application",
  arguments: { name: throwawayName, description: "Created by scripts/smoke-test.mjs - safe to delete, deleted by the same run." },
});
const createdApp = expectJson(created, "create_application");
console.log("created:", createdApp.id, createdApp.name);

const fetched = await client.callTool({ name: "scaleway_iam_get_application", arguments: { application_id: createdApp.id } });
console.log("fetched back:", expectJson(fetched, "get_application").name);

console.log("\n=== WRITE PATH: create -> update (no rotation) -> delete an API key ===");
const createdKey = expectJson(
  await client.callTool({
    name: "scaleway_iam_create_api_key",
    arguments: { application_id: createdApp.id, description: "smoke-test key - safe to delete, deleted by the same run." },
  }),
  "create_api_key",
);
console.log("created key:", createdKey.access_key);

const updatedKey = expectJson(
  await client.callTool({
    name: "scaleway_iam_update_api_key",
    arguments: { access_key: createdKey.access_key, description: "smoke-test key - description updated in place, no rotation" },
  }),
  "update_api_key",
);
if (updatedKey.access_key !== createdKey.access_key) {
  console.error(`FAILED: update_api_key changed access_key (${createdKey.access_key} -> ${updatedKey.access_key}) - should never rotate`);
  process.exit(1);
}
console.log("updated key description:", updatedKey.description);

const deletedKey = await client.callTool({ name: "scaleway_iam_delete_api_key", arguments: { access_key: createdKey.access_key, confirm: true } });
console.log("deleted key:", text(deletedKey));

const deleted = await client.callTool({
  name: "scaleway_iam_delete_application",
  arguments: { application_id: createdApp.id, confirm: true },
});
console.log("deleted app:", text(deleted));

const verifyGone = await client.callTool({ name: "scaleway_iam_get_application", arguments: { application_id: createdApp.id } });
console.log("verify gone - isError:", verifyGone.isError, "-", text(verifyGone).slice(0, 200));

console.log("\n=== WRITE PATH: create -> list -> delete a throwaway bucket ===");
const throwawayBucket = `mcp-smoke-test-bucket-${Date.now()}`;
const createdBucket = expectJson(
  await client.callTool({ name: "scaleway_s3_create_bucket", arguments: { bucket: throwawayBucket } }),
  "create_bucket",
);
console.log("created bucket:", createdBucket.bucket, "in", createdBucket.region);

const bucketList = expectJson(await client.callTool({ name: "scaleway_s3_list_buckets", arguments: {} }), "list_buckets");
if (!bucketList.buckets.some((b) => b.name === throwawayBucket)) {
  console.error(`FAILED: list_buckets did not include ${throwawayBucket}`);
  process.exit(1);
}
console.log(`list_buckets: found ${throwawayBucket} among ${bucketList.count} buckets`);

const deletedBucket = await client.callTool({ name: "scaleway_s3_delete_bucket", arguments: { bucket: throwawayBucket, confirm: true } });
console.log("deleted bucket:", text(deletedBucket));

const bucketListAfter = expectJson(await client.callTool({ name: "scaleway_s3_list_buckets", arguments: {} }), "list_buckets (after delete)");
if (bucketListAfter.buckets.some((b) => b.name === throwawayBucket)) {
  console.error(`FAILED: ${throwawayBucket} still present after delete_bucket`);
  process.exit(1);
}
console.log("verify gone: bucket no longer in list_buckets");

console.log("\n=== WRITE PATH (issue #8): object CRUD lifecycle ===");
const objBucket = `mcp-smoke-test-objects-${Date.now()}`;
expectJson(await client.callTool({ name: "scaleway_s3_create_bucket", arguments: { bucket: objBucket } }), "create_bucket (objects)");
console.log("created bucket:", objBucket);

const textContent = "Hello from scaleway-ops-mcp-server smoke test, issue #8.";
// Smallest valid transparent PNG (1x1) - a well-known fixture, not sensitive data.
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const putText = expectJson(
  await client.callTool({ name: "scaleway_s3_put_object", arguments: { bucket: objBucket, key: "hello.txt", content: textContent, content_type: "text/plain" } }),
  "put_object (text)",
);
console.log("put text object:", putText.key, putText.size_bytes, "bytes");

const putBinary = expectJson(
  await client.callTool({ name: "scaleway_s3_put_object", arguments: { bucket: objBucket, key: "pixel.png", content: pngBase64, encoding: "base64", content_type: "image/png" } }),
  "put_object (binary)",
);
console.log("put binary object:", putBinary.key, putBinary.size_bytes, "bytes");

const headText = expectJson(await client.callTool({ name: "scaleway_s3_head_object", arguments: { bucket: objBucket, key: "hello.txt" } }), "head_object (text)");
if (headText.content_type !== "text/plain" || headText.size_bytes !== Buffer.byteLength(textContent, "utf8")) {
  console.error(`FAILED: head_object metadata mismatch: ${JSON.stringify(headText)}`);
  process.exit(1);
}
console.log("head text object: content_type/size match");

const objList = expectJson(await client.callTool({ name: "scaleway_s3_list_objects", arguments: { bucket: objBucket } }), "list_objects");
const listedKeys = objList.objects.map((o) => o.key).sort();
if (listedKeys.join(",") !== "hello.txt,pixel.png") {
  console.error(`FAILED: list_objects expected [hello.txt, pixel.png], got [${listedKeys.join(", ")}]`);
  process.exit(1);
}
console.log("list_objects: found both keys,", objList.count, "total");

const gotText = expectJson(await client.callTool({ name: "scaleway_s3_get_object", arguments: { bucket: objBucket, key: "hello.txt" } }), "get_object (text)");
if (gotText.encoding !== "utf8" || gotText.content !== textContent) {
  console.error(`FAILED: get_object text round-trip mismatch: encoding=${gotText.encoding} content=${JSON.stringify(gotText.content)}`);
  process.exit(1);
}
console.log("get_object text: byte-identical round-trip confirmed (utf8)");

const gotBinary = expectJson(await client.callTool({ name: "scaleway_s3_get_object", arguments: { bucket: objBucket, key: "pixel.png" } }), "get_object (binary)");
if (gotBinary.encoding !== "base64" || gotBinary.content !== pngBase64) {
  console.error(`FAILED: get_object binary round-trip mismatch: encoding=${gotBinary.encoding}`);
  process.exit(1);
}
console.log("get_object binary: byte-identical round-trip confirmed (base64)");

const tagsBefore = expectJson(await client.callTool({ name: "scaleway_s3_get_object_tags", arguments: { bucket: objBucket, key: "hello.txt" } }), "get_object_tags (before)");
console.log("tags before:", JSON.stringify(tagsBefore.tags));
expectJson(
  await client.callTool({ name: "scaleway_s3_put_object_tags", arguments: { bucket: objBucket, key: "hello.txt", tags: { env: "smoke-test" } } }),
  "put_object_tags",
);
const tagsAfter = expectJson(await client.callTool({ name: "scaleway_s3_get_object_tags", arguments: { bucket: objBucket, key: "hello.txt" } }), "get_object_tags (after)");
if (tagsAfter.tags.env !== "smoke-test") {
  console.error(`FAILED: put_object_tags did not take effect, got ${JSON.stringify(tagsAfter.tags)}`);
  process.exit(1);
}
console.log("object tags: set and read back correctly");

const copied = expectJson(
  await client.callTool({ name: "scaleway_s3_copy_object", arguments: { source_bucket: objBucket, source_key: "hello.txt", dest_bucket: objBucket, dest_key: "hello-copy.txt" } }),
  "copy_object",
);
console.log("copied:", copied.source_key, "->", copied.dest_key);
const listAfterCopy = expectJson(await client.callTool({ name: "scaleway_s3_list_objects", arguments: { bucket: objBucket } }), "list_objects (after copy)");
if (!listAfterCopy.objects.some((o) => o.key === "hello-copy.txt")) {
  console.error("FAILED: hello-copy.txt missing from list_objects after copy_object");
  process.exit(1);
}
console.log("list_objects: copy confirmed present");

const presigned = expectJson(
  await client.callTool({ name: "scaleway_s3_generate_presigned_url", arguments: { bucket: objBucket, key: "hello.txt", operation: "get", expires_in_seconds: 300 } }),
  "generate_presigned_url",
);
const presignedFetch = await fetch(presigned.url);
const presignedBody = await presignedFetch.text();
if (!presignedFetch.ok || presignedBody !== textContent) {
  console.error(`FAILED: presigned GET url returned status=${presignedFetch.status} body=${JSON.stringify(presignedBody)}`);
  process.exit(1);
}
console.log("presigned GET url: fetched directly, content matches (verifies signature works, not just that a URL was returned)");

const deletedCopy = expectJson(
  await client.callTool({ name: "scaleway_s3_delete_object", arguments: { bucket: objBucket, key: "hello-copy.txt", confirm: true } }),
  "delete_object",
);
console.log("deleted single object:", deletedCopy.key);

const batchDeleted = expectJson(
  await client.callTool({ name: "scaleway_s3_delete_objects", arguments: { bucket: objBucket, keys: ["hello.txt", "pixel.png"], confirm: true } }),
  "delete_objects",
);
if (batchDeleted.errors.length > 0 || batchDeleted.deleted.sort().join(",") !== "hello.txt,pixel.png") {
  console.error(`FAILED: delete_objects unexpected result: ${JSON.stringify(batchDeleted)}`);
  process.exit(1);
}
console.log("batch-deleted:", batchDeleted.deleted.join(", "));

const listFinal = expectJson(await client.callTool({ name: "scaleway_s3_list_objects", arguments: { bucket: objBucket } }), "list_objects (final)");
if (listFinal.count !== 0) {
  console.error(`FAILED: bucket not empty before delete_bucket: ${JSON.stringify(listFinal.objects)}`);
  process.exit(1);
}
console.log("list_objects: bucket empty, ready to delete");

const deletedObjBucket = await client.callTool({ name: "scaleway_s3_delete_bucket", arguments: { bucket: objBucket, confirm: true } });
console.log("deleted object-test bucket:", text(deletedObjBucket));
const bucketsAfterObjTest = expectJson(await client.callTool({ name: "scaleway_s3_list_buckets", arguments: {} }), "list_buckets (after object test)");
if (bucketsAfterObjTest.buckets.some((b) => b.name === objBucket)) {
  console.error(`FAILED: ${objBucket} still present after delete_bucket`);
  process.exit(1);
}
console.log("verify gone: object-test bucket no longer in list_buckets");

console.log("\n=== AUDIT TRAIL (issue #9): registered audit tools ===");
const tools = await client.listTools();
const auditTools = tools.tools.filter((t) => t.name.startsWith("scaleway_audit_")).map((t) => t.name);
console.log(auditTools.join("\n"));

console.log("\n=== AUDIT TRAIL (issue #9): read paths (tolerant - permission coverage may vary) ===");
const auditReads = [
  ["scaleway_audit_list_authentication_events", { max_pages: 1 }],
  ["scaleway_audit_list_system_events", { max_pages: 1 }],
  ["scaleway_audit_list_combined_events", { max_pages: 1 }],
  ["scaleway_audit_get_last_events_overview", {}],
  ["scaleway_audit_list_products", {}],
  ["scaleway_audit_list_alert_rules", {}],
  ["scaleway_audit_list_custom_alert_rules", {}],
  ["scaleway_audit_list_export_jobs", {}],
];
for (const [name, args] of auditReads) {
  const res = await client.callTool({ name, arguments: args });
  const body = text(res).slice(0, 200).replace(/\n/g, " ");
  console.log(`${res.isError ? "ERROR" : "ok   "} ${name}: ${body}`);
}

console.log("\n=== AUDIT TRAIL (issue #9): custom alert rule lifecycle (write path - may lack permissions) ===");
const ruleName = `mcp-smoke-test-alert-${Date.now()}`;
const createdRule = await client.callTool({
  name: "scaleway_audit_create_custom_alert_rule",
  arguments: {
    name: ruleName,
    description: "smoke-test rule - safe to delete, deleted by the same run.",
    query: 'event.method_name == "ListApplications"',
    occurrences: 1,
  },
});
if (createdRule.isError) {
  console.log("create blocked (expected if credential lacks Audit Trail write perms):", text(createdRule).slice(0, 300));
} else {
  const rule = JSON.parse(text(createdRule));
  console.log("created rule:", rule.id, "status:", rule.status, "severity:", rule.severity);
  const updated = await client.callTool({
    name: "scaleway_audit_update_custom_alert_rule",
    arguments: { custom_alert_rule_id: rule.id, description: "smoke-test rule - description updated in place." },
  });
  if (updated.isError) {
    console.log("FAILED at update_custom_alert_rule:", text(updated));
    process.exit(1);
  }
  console.log("updated description:", JSON.parse(text(updated)).description);
  const del = await client.callTool({
    name: "scaleway_audit_delete_custom_alert_rule",
    arguments: { custom_alert_rule_id: rule.id, confirm: true },
  });
  if (del.isError) {
    console.log("FAILED at delete_custom_alert_rule:", text(del));
    process.exit(1);
  }
  console.log("deleted rule:", text(del));
  const listAfter = await client.callTool({ name: "scaleway_audit_list_custom_alert_rules", arguments: {} });
  const remaining = JSON.parse(text(listAfter)).custom_alert_rules.filter((r) => r.id === rule.id);
  if (remaining.length > 0) {
    console.error(`FAILED: rule ${rule.id} still present after delete`);
    process.exit(1);
  }
  console.log("verify gone: rule no longer in list_custom_alert_rules");
}

console.log("\n=== BUCKET CONFIG (issue #7): full config lifecycle on a throwaway bucket ===");
const cfgBucket = `mcp-smoke-test-config-${Date.now()}`;
expectJson(await client.callTool({ name: "scaleway_s3_create_bucket", arguments: { bucket: cfgBucket } }), "create config bucket");

async function expectError(name, args, label) {
  const res = await client.callTool({ name, arguments: args });
  if (!res.isError) {
    console.error(`FAILED at "${label}": expected an error, got success`);
    process.exit(1);
  }
  console.log(`guard ok (${label}): ${text(res).slice(0, 110)}`);
  return text(res);
}

try {
  // --- tagging ---
  const tags = expectJson(
    await client.callTool({
      name: "scaleway_s3_put_bucket_tagging",
      arguments: { bucket: cfgBucket, tags: [{ key: "purpose", value: "smoke-test" }, { key: "owner", value: "mcp" }] },
    }),
    "put_bucket_tagging",
  );
  console.log("tagging applied:", tags.applied);
  const tagsBack = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_tagging", arguments: { bucket: cfgBucket } }), "get_bucket_tagging");
  if (tagsBack.tags.length !== 2) { console.error("FAILED: get_bucket_tagging echo mismatch"); process.exit(1); }
  console.log("tagging get: 2/2 tags echoed");
  console.log("tagging delete:", text(await client.callTool({ name: "scaleway_s3_delete_bucket_tagging", arguments: { bucket: cfgBucket, confirm: true } })).slice(0, 80));
  await expectError("scaleway_s3_get_bucket_tagging", { bucket: cfgBucket }, "no tags after delete");

  // --- CORS ---
  expectJson(
    await client.callTool({
      name: "scaleway_s3_put_bucket_cors",
      arguments: { bucket: cfgBucket, rules: [{ allowed_origins: ["https://example.com"], allowed_methods: ["GET"], max_age_seconds: 900 }] },
    }),
    "put_bucket_cors",
  );
  const cors = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_cors", arguments: { bucket: cfgBucket } }), "get_bucket_cors");
  if (cors.rules.length !== 1 || cors.rules[0].allowed_origins[0] !== "https://example.com") { console.error("FAILED: cors echo mismatch"); process.exit(1); }
  console.log("cors get: rule echoed");
  console.log("cors delete:", text(await client.callTool({ name: "scaleway_s3_delete_bucket_cors", arguments: { bucket: cfgBucket } })).slice(0, 80));

  // --- versioning: enable -> verify -> suspend-guard -> suspend -> verify ---
  console.log("versioning enable:", text(await client.callTool({ name: "scaleway_s3_set_bucket_versioning", arguments: { bucket: cfgBucket, status: "Enabled" } })).slice(0, 80));
  let v = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_versioning", arguments: { bucket: cfgBucket } }), "get versioning");
  if (v.status !== "Enabled") { console.error("FAILED: versioning not Enabled"); process.exit(1); }
  await expectError("scaleway_s3_set_bucket_versioning", { bucket: cfgBucket, status: "Suspended" }, "suspend without confirm rejected");
  console.log("versioning suspend:", text(await client.callTool({ name: "scaleway_s3_set_bucket_versioning", arguments: { bucket: cfgBucket, status: "Suspended", confirm: true } })).slice(0, 80));
  v = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_versioning", arguments: { bucket: cfgBucket } }), "get versioning after suspend");
  if (v.status !== "Suspended") { console.error("FAILED: versioning not Suspended"); process.exit(1); }
  console.log("versioning: enable -> suspend verified");
  console.log("versioning re-enable:", text(await client.callTool({ name: "scaleway_s3_set_bucket_versioning", arguments: { bucket: cfgBucket, status: "Enabled" } })).slice(0, 80));

  // --- website ---
  console.log("website put:", text(await client.callTool({ name: "scaleway_s3_put_bucket_website", arguments: { bucket: cfgBucket, index_document: "index.html", error_document: "error.html", confirm: true } })).slice(0, 90));
  const site = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_website", arguments: { bucket: cfgBucket } }), "get_bucket_website");
  if (site.index_document !== "index.html" || site.error_document !== "error.html") { console.error("FAILED: website echo mismatch"); process.exit(1); }
  console.log("website get: index+error echoed");
  console.log("website delete:", text(await client.callTool({ name: "scaleway_s3_delete_bucket_website", arguments: { bucket: cfgBucket } })).slice(0, 80));

  // --- visibility ---
  const vis0 = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_visibility", arguments: { bucket: cfgBucket } }), "get visibility initial");
  if (vis0.visibility !== "private") { console.error("FAILED: new bucket not private"); process.exit(1); }
  await expectError("scaleway_s3_set_bucket_visibility", { bucket: cfgBucket, visibility: "public-read" }, "public without confirm rejected");
  await expectError("scaleway_s3_generate_presigned_url", { bucket: cfgBucket, key: "probe.txt", operation: "put" }, "presigned put without confirm rejected");
  console.log("visibility public:", text(await client.callTool({ name: "scaleway_s3_set_bucket_visibility", arguments: { bucket: cfgBucket, visibility: "public-read", confirm: true } })).slice(0, 80));
  const vis1 = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_visibility", arguments: { bucket: cfgBucket } }), "get visibility public");
  if (vis1.visibility !== "public") { console.error("FAILED: visibility not public after set"); process.exit(1); }
  console.log("visibility: private -> public verified (AllUsers grant present:", JSON.stringify(vis1.grants.some((g) => g.grantee?.includes("AllUsers"))), ")");
  console.log("visibility private again:", text(await client.callTool({ name: "scaleway_s3_set_bucket_visibility", arguments: { bucket: cfgBucket, visibility: "private" } })).slice(0, 80));

  // --- lifecycle ---
  expectJson(
    await client.callTool({
      name: "scaleway_s3_put_bucket_lifecycle",
      arguments: { bucket: cfgBucket, rules: [{ id: "expire-probe", enabled: true, prefix: "probe/", expiration_days: 1 }], confirm: true },
    }),
    "put_bucket_lifecycle",
  );
  const lc = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_lifecycle", arguments: { bucket: cfgBucket } }), "get_bucket_lifecycle");
  if (lc.rules.length !== 1 || lc.rules[0].expiration_days !== 1) { console.error("FAILED: lifecycle echo mismatch"); process.exit(1); }
  console.log("lifecycle get: rule echoed");
  console.log("lifecycle delete:", text(await client.callTool({ name: "scaleway_s3_delete_bucket_lifecycle", arguments: { bucket: cfgBucket, confirm: true } })).slice(0, 80));

  // --- encryption (declarative) ---
  console.log("encryption put:", text(await client.callTool({ name: "scaleway_s3_put_bucket_encryption", arguments: { bucket: cfgBucket, algorithm: "AES256" } })).slice(0, 80));
  const enc = expectJson(await client.callTool({ name: "scaleway_s3_get_bucket_encryption", arguments: { bucket: cfgBucket } }), "get_bucket_encryption");
  if (!enc.rules?.some((r) => r.algorithm === "AES256")) { console.error("FAILED: encryption echo mismatch"); process.exit(1); }
  console.log("encryption get: AES256 echoed");
  console.log("encryption delete:", text(await client.callTool({ name: "scaleway_s3_delete_bucket_encryption", arguments: { bucket: cfgBucket } })).slice(0, 80));

  // --- object lock (one-way; this throwaway bucket is deleted right after) ---
  // Suspend versioning first so the instructive-error path below is actually reachable.
  console.log("versioning suspend for lock-negative test:", text(await client.callTool({ name: "scaleway_s3_set_bucket_versioning", arguments: { bucket: cfgBucket, status: "Suspended", confirm: true } })).slice(0, 80));
  await expectError("scaleway_s3_enable_object_lock", { bucket: cfgBucket, confirm: true }, "lock without versioning rejected instructively");
  const lock = expectJson(
    await client.callTool({ name: "scaleway_s3_enable_object_lock", arguments: { bucket: cfgBucket, enable_versioning_if_needed: true, confirm: true } }),
    "enable_object_lock",
  );
  console.log("object lock enabled:", lock.object_lock_enabled, "- versioning auto-enabled:", lock.versioning_now);
  const lockBack = expectJson(await client.callTool({ name: "scaleway_s3_get_object_lock", arguments: { bucket: cfgBucket } }), "get_object_lock");
  if (lockBack.object_lock_enabled !== "Enabled") { console.error("FAILED: object lock not echoed as Enabled"); process.exit(1); }
  await expectError("scaleway_s3_set_bucket_versioning", { bucket: cfgBucket, status: "Suspended", confirm: true }, "versioning suspend blocked while locked");
  console.log("object lock: enabled, echoed, versioning frozen - verified");
} finally {
  // Zero-residue teardown: empty bucket deletes fine even with lock+versioning enabled (probe-verified)
  console.log("config bucket teardown:", text(await client.callTool({ name: "scaleway_s3_delete_bucket", arguments: { bucket: cfgBucket, confirm: true } })).slice(0, 80));
  const listCfg = expectJson(await client.callTool({ name: "scaleway_s3_list_buckets", arguments: {} }), "list_buckets after teardown");
  if (listCfg.buckets.some((b) => b.name === cfgBucket)) { console.error(`FAILED: ${cfgBucket} still present after teardown`); process.exit(1); }
  console.log("verify gone: config bucket no longer in list_buckets");
}

console.log("\n=== IAM USERS (issue #4): path-2 verification - reads live, mutations negative-only (no disposable mailbox) ===");
const usersList = expectJson(await client.callTool({ name: "scaleway_iam_list_users", arguments: {} }), "list_users");
if (usersList.total_count < 1) { console.error("FAILED: expected at least the org owner in list_users"); process.exit(1); }
const owner = usersList.users.find((u) => u.type === "owner");
// CodeQL js/clear-text-logging flags this (dismissed as false positive - see the alert):
// this is a manual, local-only dev utility printing the caller's own account data to their own
// terminal, not a service log. Neither id nor mfa_enabled is a secret.
console.log(`list_users: ${usersList.total_count} user(s), owner present: ${!!owner} (id ${owner?.id ?? "-"}, mfa: ${owner?.mfa_enabled})`);

const gotUser = expectJson(await client.callTool({ name: "scaleway_iam_get_user", arguments: { user_id: owner.id } }), "get_user");
if (gotUser.id !== owner.id || gotUser.type !== "owner") { console.error("FAILED: get_user mismatch"); process.exit(1); }
console.log("get_user: owner echoed (status:", gotUser.status + ", locked:", gotUser.locked + ")");

const bogusId = "00000000-0000-4000-8000-000000000000";

// Guard negative-tests: missing confirm rejected BEFORE any API call
for (const [name, args, label] of [
  ["scaleway_iam_create_user", { email: "nobody-invalid@example.invalid", type: "guest" }, "create without confirm"],
  ["scaleway_iam_delete_user", { user_id: bogusId }, "delete without confirm"],
  ["scaleway_iam_lock_user", { user_id: bogusId }, "lock without confirm"],
  ["scaleway_iam_update_user_password", { user_id: bogusId, password: "Xy9!mQ2#kL7%pR4z" }, "password without confirm"],
  ["scaleway_iam_update_user_username", { user_id: bogusId, new_username: "probe_xyz" }, "username without confirm"],
  ["scaleway_iam_delete_user_mfa_otp", { user_id: bogusId }, "mfa delete without confirm"],
  ["scaleway_iam_set_policy_rules", { policy_id: bogusId, rules: [{ permission_set_names: ["IAMPolicyManager"], organization_id: bogusId }] }, "set_policy_rules without confirm"],
]) {
  const res = await client.callTool({ name, arguments: args });
  if (!res.isError) { console.error(`FAILED at "${label}": expected schema rejection, got success`); process.exit(1); }
  console.log(`guard ok (${label}): rejected`);
}

// Owner-refusal belt-and-braces: delete on the real OWNER must be refused by the tool itself
const ownerDel = await client.callTool({ name: "scaleway_iam_delete_user", arguments: { user_id: owner.id, confirm: true } });
if (!ownerDel.isError || !text(ownerDel).includes("OWNER")) { console.error("FAILED: owner delete not refused:", text(ownerDel)); process.exit(1); }
console.log("guard ok (owner delete refused):", text(ownerDel).slice(0, 90));

// Bogus-id mutations with confirm: API 404 shapes surfaced verbatim, no real user touched
for (const [name, args, label] of [
  ["scaleway_iam_update_user", { user_id: bogusId, tags: ["probe"] }, "update bogus id"],
  ["scaleway_iam_delete_user", { user_id: bogusId, confirm: true }, "delete bogus id"],
  ["scaleway_iam_lock_user", { user_id: bogusId, confirm: true }, "lock bogus id"],
  ["scaleway_iam_unlock_user", { user_id: bogusId }, "unlock bogus id"],
  ["scaleway_iam_update_user_username", { user_id: bogusId, new_username: "probe_xyz", confirm: true }, "username bogus id"],
  ["scaleway_iam_delete_user_mfa_otp", { user_id: bogusId, confirm: true }, "mfa delete bogus id"],
  ["scaleway_iam_list_user_grace_periods", { user_id: bogusId }, "grace periods bogus id"],
]) {
  const res = await client.callTool({ name, arguments: args });
  if (!res.isError) { console.error(`FAILED at "${label}": expected API error, got success`); process.exit(1); }
  console.log(`api err ok (${label}): ${text(res).slice(0, 100)}`);
}

// Regression guard: update_user_password must actually send the password in the request body.
// A bogus id with a valid password must fail with the API's "resource: user" 404 - NOT a "password
// required"-style validation error, which is what a body-omission bug (previously shipped) produces
// instead, since the missing field gets caught before the id is ever looked up.
const bogusPassword = await client.callTool({
  name: "scaleway_iam_update_user_password",
  arguments: { user_id: bogusId, password: "Xy9!mQ2#kL7%pR4z", confirm: true },
});
if (!bogusPassword.isError || !text(bogusPassword).includes("resource is not found")) {
  // Do not render the API response: it can include the password supplied above.
  console.error("FAILED: update_user_password did not surface the expected bogus-id 404 (password body likely not sent)");
  process.exit(1);
}
console.log("api err ok (password bogus id): password reached the API and the id lookup 404'd, as expected");

// Create negative-only: invalid email must be rejected by the API (validation fires before any email is sent)
const badCreate = await client.callTool({ name: "scaleway_iam_create_user", arguments: { email: "not-an-email", type: "guest", confirm: true } });
if (!badCreate.isError || !text(badCreate).includes("email")) { console.error("FAILED: invalid-email create not rejected as expected:", text(badCreate)); process.exit(1); }
console.log("api err ok (create invalid email rejected):", text(badCreate).slice(0, 110));
console.log("users: path-2 verification complete - reads live-verified, mutations guard+error verified, zero writes to real humans");

console.log("\n=== IAM SSH KEYS / JWTs / SAML / SCIM / Security Settings (issue #6) ===");

// SSH keys: full CRUD live, try/finally so a throwaway key is never left behind even on failure.
// A hardcoded throwaway ed25519 public key (generated once for this purpose, private half discarded
// immediately, never reused/committed) - Scaleway validates key format, not that it's "real"/in-use.
const throwawayPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGWnTSmjgmGkchKTBiy8DJpG3YWNQXaHTHsL5aeuZTJU mcp-smoke-test-throwaway";
let createdSshKeyId;
try {
  const createdKey = expectJson(
    await client.callTool({ name: "scaleway_iam_create_ssh_key", arguments: { name: `mcp-smoke-test-ssh-key-${Date.now()}`, public_key: throwawayPublicKey } }),
    "create_ssh_key",
  );
  createdSshKeyId = createdKey.id;
  console.log("created ssh key:", createdSshKeyId, createdKey.fingerprint);

  const gotKey = expectJson(await client.callTool({ name: "scaleway_iam_get_ssh_key", arguments: { ssh_key_id: createdSshKeyId } }), "get_ssh_key");
  // Compare on the key material + type only - Scaleway may reformat whitespace/trailing newline
  // or drop/alter the comment field, none of which is the part that actually matters.
  const normalize = (k) => k.trim().split(/\s+/).slice(0, 2).join(" ");
  if (normalize(gotKey.public_key) !== normalize(throwawayPublicKey)) {
    throw new Error(`get_ssh_key public_key mismatch: sent=${JSON.stringify(throwawayPublicKey)} got=${JSON.stringify(gotKey.public_key)}`);
  }
  console.log("get_ssh_key: public_key matches (key type + material)");

  const sshList = expectJson(await client.callTool({ name: "scaleway_iam_list_ssh_keys", arguments: {} }), "list_ssh_keys");
  if (!sshList.ssh_keys.some((k) => k.id === createdSshKeyId)) throw new Error("list_ssh_keys missing the created key");
  console.log(`list_ssh_keys: found created key among ${sshList.total_count} total (the account's own real key is among them - never touched)`);

  const renamedKey = expectJson(
    await client.callTool({ name: "scaleway_iam_update_ssh_key", arguments: { ssh_key_id: createdSshKeyId, name: "mcp-smoke-test-ssh-key-renamed" } }),
    "update_ssh_key",
  );
  if (renamedKey.name !== "mcp-smoke-test-ssh-key-renamed") throw new Error("update_ssh_key name did not change");
  console.log("update_ssh_key: renamed");

  // Client-side private-key rejection guard - must never reach the API
  const rejectedPrivate = await client.callTool({
    name: "scaleway_iam_create_ssh_key",
    arguments: { name: "should-never-be-created", public_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nfakefakefake\n-----END OPENSSH PRIVATE KEY-----" },
  });
  if (!rejectedPrivate.isError) throw new Error("create_ssh_key accepted a PEM private-key block");
  console.log("guard ok (private key rejected client-side):", text(rejectedPrivate).slice(0, 80));
} finally {
  // finally runs even if the try block throws - the throwaway key is never left behind.
  if (createdSshKeyId) {
    const deletedKey = await client.callTool({ name: "scaleway_iam_delete_ssh_key", arguments: { ssh_key_id: createdSshKeyId, confirm: true } });
    console.log("deleted ssh key (cleanup):", text(deletedKey));
  }
}
const sshListAfter = expectJson(await client.callTool({ name: "scaleway_iam_list_ssh_keys", arguments: {} }), "list_ssh_keys (after cleanup)");
if (sshListAfter.ssh_keys.some((k) => k.id === createdSshKeyId)) { console.error("FAILED: throwaway ssh key still present after delete"); process.exit(1); }
console.log("verify gone: throwaway ssh key no longer in list_ssh_keys, zero residue");

// JWTs: live-probed 2026-08-18 that this Application/API-key credential gets 403 on 'self_jwt' even
// with full IAMManager - documenting that as the expected result rather than treating it as a failure.
const jwtProbe = await client.callTool({ name: "scaleway_iam_list_jwts", arguments: { audience_id: owner.id } });
console.log(`jwts: list against the org owner's id -> isError=${jwtProbe.isError}, ${text(jwtProbe).slice(0, 140)} (403/self_jwt expected - documented API-key limitation, not a test failure)`);

// SAML / SCIM: GET must show "not configured" (the correct, safe default state) - and every mutating
// tool is guard-tested ONLY. Never call enable/disable live - see docs/gotchas.md for why.
const samlGet = await client.callTool({ name: "scaleway_iam_get_saml_config", arguments: {} });
if (!samlGet.isError) { console.error("FAILED: expected SAML to read as not-configured, got a config:", text(samlGet)); process.exit(1); }
console.log("get_saml_config: not configured (expected default state)");
const scimGet = await client.callTool({ name: "scaleway_iam_get_scim_config", arguments: {} });
if (!scimGet.isError) { console.error("FAILED: expected SCIM to read as not-configured, got a config:", text(scimGet)); process.exit(1); }
console.log("get_scim_config: not configured (expected default state)");

for (const [name, args, label] of [
  ["scaleway_iam_enable_saml", { entity_id: "https://idp.example.invalid", single_sign_on_url: "https://idp.example.invalid/sso" }, "enable_saml without confirm"],
  ["scaleway_iam_disable_saml", {}, "disable_saml without confirm"],
  ["scaleway_iam_enable_scim", {}, "enable_scim without confirm"],
  ["scaleway_iam_disable_scim", {}, "disable_scim without confirm"],
  ["scaleway_iam_delete_jwt", { jti: bogusId }, "delete_jwt without confirm"],
  ["scaleway_audit_create_export_job", { name: "probe", bucket: "probe-bucket" }, "create_export_job without confirm"],
]) {
  const res = await client.callTool({ name, arguments: args });
  if (!res.isError) { console.error(`FAILED at "${label}": expected schema rejection, got success`); process.exit(1); }
  console.log(`guard ok (${label}): rejected`);
}
console.log("saml/scim/jwt mutations: guard-tested only, never called live - org-wide state, see verification protocol in issue #6");

// Security Settings: real live read, plus ONE genuinely safe live mutation call - an update with
// confirm:true and no other fields changes nothing (live-confirmed while building this: Security
// Settings' PATCH follows real "only passed fields change" semantics, unlike SAML/SCIM's enable).
const secBefore = expectJson(await client.callTool({ name: "scaleway_iam_get_security_settings", arguments: {} }), "get_security_settings");
console.log("security settings:", JSON.stringify(secBefore));
const secNoop = expectJson(await client.callTool({ name: "scaleway_iam_update_security_settings", arguments: { confirm: true } }), "update_security_settings (no-op)");
if (JSON.stringify(secNoop) !== JSON.stringify(secBefore)) {
  console.error(`FAILED: no-op update_security_settings changed values: before=${JSON.stringify(secBefore)} after=${JSON.stringify(secNoop)}`);
  process.exit(1);
}
console.log("update_security_settings: confirm-only no-op call left every value unchanged, as expected");

console.log("\nQUOTAS (issue #6): deferred - no dedicated Quotas API endpoint could be found live (10+ path");
console.log("attempts across IAM v1alpha1 and Account v2/v2alpha1/v3, org- and project-scoped). See");
console.log("docs/gotchas.md and docs/capability-gap-analysis.md for the full evidence trail.");

console.log("\n=== IAM GROUPS (issue #5): full happy-path lifecycle, zero blast radius ===");

const groupsBaseline = expectJson(await client.callTool({ name: "scaleway_iam_list_groups", arguments: {} }), "list_groups (baseline)");
console.log(`list_groups baseline: ${groupsBaseline.total_count} group(s) - ${groupsBaseline.groups.map((g) => g.name).join(", ")}`);
const specialGroups = groupsBaseline.groups.filter(
  (g) => g.managed || g.all_users || g.all_applications || g.editable === false || g.deletable === false,
);
console.log(
  `special/non-editable groups present: ${specialGroups.length} - ${specialGroups.map((g) => `${g.name}(editable=${g.editable},deletable=${g.deletable},managed=${g.managed})`).join(", ") || "none; managed-flag guard untested live (see docs/gotchas.md)"}`,
);

// Like expectJson, but throws instead of process.exit(1) - required inside a try/finally so
// cleanup still runs on failure (process.exit() skips pending finally blocks entirely).
function expectJsonOrThrow(res, label) {
  if (res.isError) throw new Error(`FAILED at "${label}": ${text(res)}`);
  return JSON.parse(text(res));
}

let createdGroupId, throwawayAppId;
try {
  const groupName = `mcp-smoke-test-group-${Date.now()}`;
  const createdGroup = expectJsonOrThrow(await client.callTool({ name: "scaleway_iam_create_group", arguments: { name: groupName, description: "smoke-test group" } }), "create_group");
  createdGroupId = createdGroup.id;
  console.log("created group:", createdGroupId, createdGroup.name);

  const gotGroup = expectJsonOrThrow(await client.callTool({ name: "scaleway_iam_get_group", arguments: { group_id: createdGroupId } }), "get_group");
  if (gotGroup.name !== groupName || gotGroup.user_ids.length !== 0) throw new Error(`get_group mismatch: ${JSON.stringify(gotGroup)}`);
  console.log("get_group: echoes name, empty membership");

  const byName = expectJsonOrThrow(await client.callTool({ name: "scaleway_iam_list_groups", arguments: { name: groupName } }), "list_groups (name filter)");
  if (byName.total_count !== 1 || byName.groups[0].id !== createdGroupId) throw new Error(`list_groups name filter failed: ${JSON.stringify(byName)}`);
  const byId = expectJsonOrThrow(await client.callTool({ name: "scaleway_iam_list_groups", arguments: { group_ids: [createdGroupId] } }), "list_groups (group_ids filter)");
  if (byId.total_count !== 1 || byId.groups[0].id !== createdGroupId) throw new Error(`list_groups group_ids filter failed: ${JSON.stringify(byId)}`);
  console.log("list_groups: name filter (exact) and group_ids filter both isolate the created group");

  const renamedGroup = expectJsonOrThrow(
    await client.callTool({ name: "scaleway_iam_update_group", arguments: { group_id: createdGroupId, name: `${groupName}-renamed`, description: "renamed" } }),
    "update_group",
  );
  if (renamedGroup.name !== `${groupName}-renamed`) throw new Error("update_group name did not change");
  console.log("update_group: renamed + description updated");

  if (specialGroups.length > 0) {
    const specialUpdate = await client.callTool({ name: "scaleway_iam_update_group", arguments: { group_id: specialGroups[0].id, name: "should-be-refused" } });
    if (!specialUpdate.isError) throw new Error("update_group did not refuse a special group");
    console.log("guard ok (special-group update refused):", text(specialUpdate).slice(0, 90));
    const specialDelete = await client.callTool({ name: "scaleway_iam_delete_group", arguments: { group_id: specialGroups[0].id, confirm: true } });
    if (!specialDelete.isError) throw new Error("delete_group did not refuse a special group");
    console.log("guard ok (special-group delete refused):", text(specialDelete).slice(0, 90));
  } else {
    console.log("special-group guard: SKIPPED (none exist on this org) - refusal logic implemented per spec, unverified against a real one");
  }

  // Throwaway application, for membership testing - reuses the same create/delete pattern as the
  // very first WRITE PATH section above.
  const throwawayApp = expectJsonOrThrow(
    await client.callTool({ name: "scaleway_iam_create_application", arguments: { name: `mcp-smoke-test-group-member-app-${Date.now()}`, description: "smoke-test group member - safe to delete" } }),
    "create_application (group member)",
  );
  throwawayAppId = throwawayApp.id;
  console.log("created throwaway application for membership tests:", throwawayAppId);

  const addedOne = expectJsonOrThrow(
    await client.callTool({ name: "scaleway_iam_add_group_member", arguments: { group_id: createdGroupId, application_id: throwawayAppId } }),
    "add_group_member",
  );
  if (!addedOne.application_ids.includes(throwawayAppId)) throw new Error("add_group_member did not add the application");
  console.log("add_group_member: application added");

  const addNeitherRejected = await client.callTool({ name: "scaleway_iam_add_group_member", arguments: { group_id: createdGroupId } });
  if (!addNeitherRejected.isError) throw new Error("add_group_member accepted neither user_id nor application_id");
  console.log("guard ok (add_group_member with neither id rejected):", text(addNeitherRejected).slice(0, 90));

  const addedMulti = expectJsonOrThrow(
    await client.callTool({ name: "scaleway_iam_add_group_members", arguments: { group_id: createdGroupId, user_ids: [owner.id] } }),
    "add_group_members",
  );
  if (!addedMulti.user_ids.includes(owner.id) || !addedMulti.application_ids.includes(throwawayAppId)) {
    throw new Error(`add_group_members did not preserve existing + add new: ${JSON.stringify(addedMulti)}`);
  }
  console.log("add_group_members: additive - both members present (proves existing membership was preserved)");

  const overwritten = expectJsonOrThrow(
    await client.callTool({ name: "scaleway_iam_set_group_members", arguments: { group_id: createdGroupId, user_ids: [], application_ids: [throwawayAppId], confirm: true } }),
    "set_group_members",
  );
  if (overwritten.user_ids.length !== 0 || !overwritten.application_ids.includes(throwawayAppId)) {
    throw new Error(`set_group_members did not full-replace as expected: ${JSON.stringify(overwritten)}`);
  }
  console.log("set_group_members: full-replace confirmed - the owner user_id is gone, only the application remains (H3 resolved)");

  const setWithoutConfirm = await client.callTool({ name: "scaleway_iam_set_group_members", arguments: { group_id: createdGroupId, user_ids: [], application_ids: [] } });
  if (!setWithoutConfirm.isError) throw new Error("set_group_members accepted a call without confirm");
  console.log("guard ok (set_group_members without confirm rejected)");

  const removeWithoutConfirm = await client.callTool({ name: "scaleway_iam_remove_group_member", arguments: { group_id: createdGroupId, application_id: throwawayAppId } });
  if (!removeWithoutConfirm.isError) throw new Error("remove_group_member accepted a call without confirm");
  console.log("guard ok (remove_group_member without confirm rejected)");

  const removed = expectJsonOrThrow(
    await client.callTool({ name: "scaleway_iam_remove_group_member", arguments: { group_id: createdGroupId, application_id: throwawayAppId, confirm: true } }),
    "remove_group_member",
  );
  if (removed.application_ids.includes(throwawayAppId)) throw new Error("remove_group_member did not remove the application");
  console.log("remove_group_member: application removed - group membership now empty");

  // Integration cross-check: the group_id principal a Policy tool already accepts actually works
  // end to end - create a throwaway Policy naming this group, then clean it up.
  const groupPolicy = expectJsonOrThrow(
    await client.callTool({
      name: "scaleway_iam_create_policy",
      arguments: {
        name: `mcp-smoke-test-group-policy-${Date.now()}`,
        description: "smoke-test - safe to delete",
        group_id: createdGroupId,
        rules: [{ permission_set_names: ["IAMPolicyManager"], organization_id: creds.SCW_ORGANIZATION_ID }],
      },
    }),
    "create_policy (group_id principal)",
  );
  console.log("create_policy: accepted this group's group_id as principal - integration loop closes");
  const deletedPolicy = await client.callTool({ name: "scaleway_iam_delete_policy", arguments: { policy_id: groupPolicy.id, confirm: true } });
  console.log("deleted cross-check policy:", text(deletedPolicy));

  const deleteWithoutConfirm = await client.callTool({ name: "scaleway_iam_delete_group", arguments: { group_id: createdGroupId } });
  if (!deleteWithoutConfirm.isError) throw new Error("delete_group accepted a call without confirm");
  console.log("guard ok (delete_group without confirm rejected)");
} finally {
  if (throwawayAppId) {
    const deletedApp = await client.callTool({ name: "scaleway_iam_delete_application", arguments: { application_id: throwawayAppId, confirm: true } });
    console.log("deleted throwaway application (cleanup):", text(deletedApp));
  }
  if (createdGroupId) {
    const deletedGroup = await client.callTool({ name: "scaleway_iam_delete_group", arguments: { group_id: createdGroupId, confirm: true } });
    console.log("deleted throwaway group (cleanup):", text(deletedGroup));
  }
}
const groupsAfter = expectJson(await client.callTool({ name: "scaleway_iam_list_groups", arguments: {} }), "list_groups (after cleanup)");
if (groupsAfter.groups.some((g) => g.id === createdGroupId)) throw new Error("throwaway group still present after delete");
console.log(`verify gone: throwaway group no longer in list_groups (back to ${groupsAfter.total_count}, zero residue)`);

await client.close();
console.log("\nDONE - full read/write/delete lifecycle verified (applications, API keys, buckets, objects, ssh keys, groups)");
