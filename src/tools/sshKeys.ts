import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { iamListAll, iamRequest, withIamErrorHandling } from "../iamClient.js";
import { toolJsonResult, toolError } from "../output.js";

/**
 * IAM SSH Keys (issue #6). Live-probed 2026-08-18: the API needs `project_id`, NOT
 * `organization_id` (list 403'd until re-queried with project_id) - `SSHKeysFullAccess`/
 * `ReadOnly` are `projects`-scope permission sets, unlike most of this server's other IAM tools.
 * See docs/gotchas.md.
 */
interface SshKey {
  id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  organization_id: string;
  project_id: string;
  created_at?: string | null;
  updated_at?: string | null;
  disabled?: boolean | null;
}

const confirmField = z.literal(true).describe("Must be explicitly true.");
const projectIdField = z.string().uuid().optional().describe("Project to scope this call to. Defaults to this server's configured project (SCW_PROJECT_ID).");

// Reject anything that looks like a PEM private-key block outright - this tool must only ever
// accept a PUBLIC key. A real SSH public key line starts with a known algorithm identifier.
const PUBLIC_KEY_PREFIXES = ["ssh-rsa", "ssh-ed25519", "ssh-dss", "ecdsa-sha2-", "sk-ssh-ed25519", "sk-ecdsa-sha2-"];

function assertLooksLikePublicKey(publicKey: string): string | null {
  const trimmed = publicKey.trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(trimmed)) {
    return "This looks like a PRIVATE key (PEM 'BEGIN ... PRIVATE KEY' block) - refusing. Only a PUBLIC key (the line starting with e.g. 'ssh-ed25519', usually from a .pub file) may be registered here.";
  }
  if (!PUBLIC_KEY_PREFIXES.some((p) => trimmed.startsWith(p))) {
    return `Doesn't look like an SSH public key - expected it to start with one of: ${PUBLIC_KEY_PREFIXES.join(", ")}.`;
  }
  return null;
}

function sshKeyView(k: SshKey) {
  return {
    id: k.id,
    name: k.name,
    fingerprint: k.fingerprint,
    project_id: k.project_id,
    disabled: k.disabled ?? false,
    created_at: k.created_at ?? null,
    updated_at: k.updated_at ?? null,
  };
}

export function registerSshKeys(server: McpServer, config: Config) {
  server.registerTool(
    "scaleway_iam_list_ssh_keys",
    {
      title: "List Scaleway IAM SSH Keys",
      description:
        "List SSH public keys registered in a Project (used to grant SSH access to Instances). Compact view - omits " +
        "the actual public_key text; use scaleway_iam_get_ssh_key for the full key if needed. Needs SSHKeysReadOnly/FullAccess.",
      inputSchema: {
        project_id: projectIdField,
        name: z.string().optional().describe("Filter by exact name."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, name }) =>
      withIamErrorHandling(async () => {
        const params = new URLSearchParams({ project_id: project_id ?? config.SCW_PROJECT_ID });
        if (name) params.set("name", name);
        const keys = await iamListAll<SshKey>(config, `/ssh-keys?${params}`, "ssh_keys");
        return toolJsonResult({ total_count: keys.length, ssh_keys: keys.map(sshKeyView) }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_get_ssh_key",
    {
      title: "Get a Scaleway IAM SSH Key",
      description: "Read one SSH key by id, including the full public_key text and fingerprint.",
      inputSchema: { ssh_key_id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ ssh_key_id }) =>
      withIamErrorHandling(async () => {
        const k = await iamRequest<SshKey>(config, "GET", `/ssh-keys/${ssh_key_id}`);
        return toolJsonResult({ ...sshKeyView(k), public_key: k.public_key }, config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_create_ssh_key",
    {
      title: "Register a Scaleway IAM SSH Key",
      description:
        "Register a PUBLIC SSH key (never a private key - rejected client-side if the payload looks like a PEM " +
        "private-key block or doesn't start with a recognized public-key prefix). This grants SSH access to any " +
        "Instance/service that trusts keys from this Project - don't call speculatively.",
      inputSchema: {
        name: z.string().min(1).describe("Label for this key, e.g. 'deploy-bot' or the person's name."),
        public_key: z.string().min(1).describe("The full public key line, e.g. 'ssh-ed25519 AAAA... comment'. NOT a private key."),
        project_id: projectIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, public_key, project_id }) => {
      const rejection = assertLooksLikePublicKey(public_key);
      if (rejection) return toolError(rejection);
      return withIamErrorHandling(async () => {
        const k = await iamRequest<SshKey>(config, "POST", "/ssh-keys", {
          name,
          public_key,
          project_id: project_id ?? config.SCW_PROJECT_ID,
        });
        return toolJsonResult(sshKeyView(k), config.MAX_OUTPUT_CHARS);
      });
    },
  );

  server.registerTool(
    "scaleway_iam_update_ssh_key",
    {
      title: "Rename a Scaleway IAM SSH Key",
      description: "Change an SSH key's name. The key material itself (public_key/fingerprint) cannot be changed here - delete and re-create to rotate the actual key.",
      inputSchema: {
        ssh_key_id: z.string().uuid(),
        name: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ ssh_key_id, name }) =>
      withIamErrorHandling(async () => {
        const k = await iamRequest<SshKey>(config, "PATCH", `/ssh-keys/${ssh_key_id}`, { name });
        return toolJsonResult(sshKeyView(k), config.MAX_OUTPUT_CHARS);
      }),
  );

  server.registerTool(
    "scaleway_iam_delete_ssh_key",
    {
      title: "Delete a Scaleway IAM SSH Key",
      description:
        "PERMANENTLY remove an SSH key. Requires confirm=true. If any Instance/service was relying solely on this " +
        "key for access, whoever holds it loses SSH access immediately - confirm it's no longer in use, or that " +
        "another access path exists, before deleting.",
      inputSchema: { ssh_key_id: z.string().uuid(), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ ssh_key_id }) =>
      withIamErrorHandling(async () => {
        await iamRequest<void>(config, "DELETE", `/ssh-keys/${ssh_key_id}`);
        return toolJsonResult({ deleted: true, ssh_key_id }, config.MAX_OUTPUT_CHARS);
      }),
  );
}
