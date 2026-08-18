#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerApplications } from "./tools/applications.js";
import { registerApiKeys } from "./tools/apiKeys.js";
import { registerPolicies } from "./tools/policies.js";
import { registerPermissionSets } from "./tools/permissionSets.js";
import { registerUsers } from "./tools/users.js";
import { registerSshKeys } from "./tools/sshKeys.js";
import { registerJwts } from "./tools/jwts.js";
import { registerSaml } from "./tools/saml.js";
import { registerScim } from "./tools/scim.js";
import { registerSecuritySettings } from "./tools/securitySettings.js";
import { registerBuckets } from "./tools/buckets.js";
import { registerBucketConfig } from "./tools/bucketConfig.js";
import { registerBucketPolicies } from "./tools/bucketPolicies.js";
import { registerObjects } from "./tools/objects.js";
import { registerAuditTrail } from "./tools/auditTrail.js";
import { registerAuditTrailAlerts } from "./tools/auditTrailAlerts.js";
import { registerAuditTrailExports } from "./tools/auditTrailExports.js";

const config = loadConfig();

const server = new McpServer({
  name: "scaleway-ops-mcp-server",
  version: "0.1.0",
});

registerApplications(server, config);
registerApiKeys(server, config);
registerPolicies(server, config);
registerPermissionSets(server, config);
registerUsers(server, config);
registerSshKeys(server, config);
registerJwts(server, config);
registerSaml(server, config);
registerScim(server, config);
registerSecuritySettings(server, config);
registerBuckets(server, config);
registerBucketConfig(server, config);
registerBucketPolicies(server, config);
registerObjects(server, config);
registerAuditTrail(server, config);
registerAuditTrailAlerts(server, config);
registerAuditTrailExports(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
