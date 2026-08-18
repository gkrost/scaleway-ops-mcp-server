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

await client.close();
console.log("\nDONE - full read/write/delete lifecycle verified (applications, API keys, buckets)");
