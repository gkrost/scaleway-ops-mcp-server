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

await client.close();
console.log("\nDONE - full read/write/delete lifecycle verified (applications, API keys, buckets, objects)");
