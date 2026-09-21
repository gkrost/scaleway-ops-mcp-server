#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerApplications } from "./tools/applications.js";
import { registerApiKeys } from "./tools/apiKeys.js";
import { registerPolicies } from "./tools/policies.js";
import { registerPermissionSets } from "./tools/permissionSets.js";
import { registerUsers } from "./tools/users.js";
import { registerGroups } from "./tools/groups.js";
import { registerSshKeys } from "./tools/sshKeys.js";
import { registerJwts } from "./tools/jwts.js";
import { registerSaml } from "./tools/saml.js";
import { registerScim } from "./tools/scim.js";
import { registerSecuritySettings } from "./tools/securitySettings.js";
import { registerBuckets } from "./tools/buckets.js";
import { registerBucketConfig } from "./tools/bucketConfig.js";
import { registerBucketStats } from "./tools/bucketStats.js";
import { registerBucketPolicies } from "./tools/bucketPolicies.js";
import { registerAccessExplain } from "./tools/accessExplain.js";
import { registerObjects } from "./tools/objects.js";
import { registerAuditTrail } from "./tools/auditTrail.js";
import { registerAuditTrailAlerts } from "./tools/auditTrailAlerts.js";
import { registerAuditTrailExports } from "./tools/auditTrailExports.js";
import { registerSecurityAudit } from "./tools/securityAudit.js";
import { resolveOwnPrincipal } from "./ownPrincipal.js";

const config = loadConfig();

const server = new McpServer({
  name: "scaleway-ops-mcp-server",
  version: "0.2.0",
});

registerApplications(server, config);
registerApiKeys(server, config);
registerPolicies(server, config);
registerPermissionSets(server, config);
registerUsers(server, config);
registerGroups(server, config);
registerSshKeys(server, config);
registerJwts(server, config);
registerSaml(server, config);
registerScim(server, config);
registerSecuritySettings(server, config);
registerBuckets(server, config);
registerBucketConfig(server, config);
registerBucketStats(server, config);
registerBucketPolicies(server, config);
registerAccessExplain(server, config);
registerObjects(server, config);
registerAuditTrail(server, config);
registerAuditTrailAlerts(server, config);
registerAuditTrailExports(server, config);
registerSecurityAudit(server, config);

// #81: fire-and-forget startup WARN when this server's own operating credential never expires.
// stderr (never stdout - the MCP protocol owns stdout), non-blocking, and a failure to resolve the
// principal must not stop the server from starting.
void resolveOwnPrincipal(config)
  .then((own) => {
    if (!own.expires_at) {
      console.error(
        `[scaleway-ops-mcp-server] WARN: this server's own operating credential (${own.access_key}) has no expiry. ` +
          "A leaked key is standing admin access - add expires_at via scaleway_iam_update_api_key or rotate to a key that has one " +
          "(see scaleway_security_audit).",
      );
    }
  })
  .catch(() => {
    // Best effort: the principal lookup itself failing must not block startup.
  });

const transport = new StdioServerTransport();
await server.connect(transport);
