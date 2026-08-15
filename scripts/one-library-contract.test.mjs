import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { buildPatch, readJson, validateContract } from "./one-library-contract.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const bundleRoot = join(repoRoot, "deploy", "one-library");
const contract = readJson(join(bundleRoot, "contract.json"));
const root = mkdtempSync(join(os.tmpdir(), "openclaw-one-library-contract-test-"));
const pluginDir = join(root, "local-plugins", contract.plugin_id);
const workspaceDir = join(root, "workspace-router");
const configPath = join(root, "openclaw.json");

try {
  cpSync(join(bundleRoot, contract.plugin_directory), pluginDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  cpSync(join(bundleRoot, contract.workspace_instruction), join(workspaceDir, "AGENTS.md"));

  const config = {
    plugins: {
      load: { paths: [pluginDir, "/opt/openclaw/extensions/planning-knowledge"] },
      entries: { [contract.plugin_id]: { enabled: true } },
    },
    mcp: {
      servers: {
        [contract.mcp_server]: { toolFilter: { include: [...contract.one_library_tools] } },
      },
    },
    agents: {
      entries: {
        [contract.agent_id]: {
          workspace: workspaceDir,
          tools: { allow: ["sessions_spawn", ...contract.one_library_tools.map((tool) => `onelibrary__${tool}`)] },
        },
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);

  const valid = validateContract({ config, contract, pluginDir, workspaceDir });
  assert.equal(valid.ok, true, valid.errors.join("; "));
  assert.equal(valid.summary.mcp_tool_count, 12);
  assert.equal(valid.summary.router_tool_count, 12);
  assert.equal(valid.summary.ask_book, true);

  const patch = buildPatch(config, contract, { pluginDir, workspaceDir });
  assert.deepEqual(patch.mcp.servers.onelibrary.toolFilter.include, contract.one_library_tools);
  assert.equal(patch.agents.entries[contract.agent_id].tools.allow.includes("sessions_spawn"), true);
  assert.equal(patch.agents.entries[contract.agent_id].tools.allow.filter((tool) => tool.startsWith("onelibrary__")).length, 12);
  assert.deepEqual(patch.plugins.load.paths, ["/opt/openclaw/extensions/planning-knowledge", pluginDir]);

  const missingAskBook = structuredClone(config);
  missingAskBook.mcp.servers.onelibrary.toolFilter.include = missingAskBook.mcp.servers.onelibrary.toolFilter.include.filter((tool) => tool !== "ask_book");
  const invalid = validateContract({ config: missingAskBook, contract, pluginDir, workspaceDir });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /ask_book/);

  console.log("one-library contract validator checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
