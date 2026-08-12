#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerApplications } from "./tools/applications.js";
import { registerApiKeys } from "./tools/apiKeys.js";
import { registerPolicies } from "./tools/policies.js";
import { registerPermissionSets } from "./tools/permissionSets.js";
import { registerBucketPolicies } from "./tools/bucketPolicies.js";
import { registerAuditTrail } from "./tools/auditTrail.js";

const config = loadConfig();

const server = new McpServer({
  name: "scaleway-ops-mcp-server",
  version: "0.1.0",
});

registerApplications(server, config);
registerApiKeys(server, config);
registerPolicies(server, config);
registerPermissionSets(server, config);
registerBucketPolicies(server, config);
registerAuditTrail(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
