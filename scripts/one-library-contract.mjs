#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BUNDLE_ROOT = resolve(REPO_ROOT, "deploy/one-library");
const CONTRACT_PATH = join(BUNDLE_ROOT, "contract.json");
const SECRET_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._-]{16,}|(?:api|gateway|telegram)[_-]?(?:key|token)\s*[:=]\s*["']?[a-z0-9._-]{16,})/i;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveDefaultStateDir() {
  return resolve(process.env.OPENCLAW_STATE_DIR || join(os.homedir(), ".openclaw"));
}

function resolvePaths(options, contract) {
  const stateDir = resolve(options.stateDir || resolveDefaultStateDir());
  const configPath = resolve(
    options.configPath || process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json"),
  );
  const workspaceDir = resolve(options.workspaceDir || join(stateDir, "workspace-router"));
  const pluginDir = resolve(
    options.pluginDir || join(stateDir, "local-plugins", contract.plugin_id),
  );
  return { stateDir, configPath, workspaceDir, pluginDir };
}

function expectedAgentTools(contract) {
  return contract.one_library_tools.map((tool) => `onelibrary__${tool}`);
}

function normalisePluginRoot(value) {
  const absolute = resolve(value);
  return basename(absolute) === "index.ts" || basename(absolute) === "index.js"
    ? dirname(absolute)
    : absolute;
}

function isPluginPath(value, contract, pluginDir) {
  if (typeof value !== "string") return false;
  const root = normalisePluginRoot(value);
  return root === resolve(pluginDir) || basename(root) === contract.plugin_id;
}

function buildPatch(config, contract, paths) {
  const mcpServer = config.mcp?.servers?.[contract.mcp_server];
  if (!mcpServer || typeof mcpServer !== "object") {
    throw new Error(
      `missing existing mcp.servers.${contract.mcp_server}; deployment does not invent MCP credentials or commands`,
    );
  }

  const existingPluginPaths = Array.isArray(config.plugins?.load?.paths)
    ? config.plugins.load.paths.filter((value) => !isPluginPath(value, contract, paths.pluginDir))
    : [];
  const pluginPaths = [...existingPluginPaths, paths.pluginDir];

  const currentAgent = config.agents?.entries?.[contract.agent_id] ?? {};
  const currentAllow = Array.isArray(currentAgent.tools?.allow) ? currentAgent.tools.allow : [];
  const libraryTools = expectedAgentTools(contract);
  const nonLibraryTools = currentAllow.filter(
    (tool) => typeof tool === "string" && !tool.startsWith("onelibrary__"),
  );
  const allow = [...new Set([...nonLibraryTools, ...libraryTools])];

  const currentPluginEntry = config.plugins?.entries?.[contract.plugin_id] ?? {};
  const patch = {
    plugins: {
      load: { paths: pluginPaths },
      entries: {
        [contract.plugin_id]: { ...currentPluginEntry, enabled: true },
      },
    },
    mcp: {
      servers: {
        [contract.mcp_server]: {
          toolFilter: { include: [...contract.one_library_tools] },
        },
      },
    },
    agents: {
      entries: {
        [contract.agent_id]: {
          workspace: paths.workspaceDir,
          tools: {
            ...(currentAgent.tools ?? {}),
            allow,
          },
        },
      },
    },
  };

  if (Array.isArray(config.plugins?.allow)) {
    patch.plugins.allow = [...new Set([...config.plugins.allow, contract.plugin_id])];
  }

  return patch;
}

function collectBundleFiles(contract) {
  return [
    join(BUNDLE_ROOT, "contract.json"),
    join(BUNDLE_ROOT, contract.workspace_instruction),
    join(BUNDLE_ROOT, contract.plugin_directory, "openclaw.plugin.json"),
    join(BUNDLE_ROOT, contract.plugin_directory, "package.json"),
    join(BUNDLE_ROOT, contract.plugin_directory, "index.ts"),
    join(BUNDLE_ROOT, contract.plugin_directory, "knowledge.js"),
    join(BUNDLE_ROOT, contract.plugin_directory, "router.js"),
  ];
}

function validateContract({ config, contract, pluginDir, workspaceDir }) {
  const errors = [];
  const expectedMcpTools = [...contract.one_library_tools].sort();
  const expectedAgent = expectedAgentTools(contract).sort();
  const actualMcpTools = config.mcp?.servers?.[contract.mcp_server]?.toolFilter?.include;
  const actualAgentAllow = config.agents?.entries?.[contract.agent_id]?.tools?.allow;
  const actualAgentLibrary = Array.isArray(actualAgentAllow)
    ? actualAgentAllow.filter((tool) => typeof tool === "string" && tool.startsWith("onelibrary__"))
    : [];

  if (
    !Array.isArray(actualMcpTools) ||
    JSON.stringify([...actualMcpTools].sort()) !== JSON.stringify(expectedMcpTools)
  ) {
    errors.push(`MCP tool contract is not exactly ${contract.one_library_tools.length} tools`);
  }
  if (!Array.isArray(actualMcpTools) || actualMcpTools.length !== new Set(actualMcpTools).size) {
    errors.push("MCP tool contract contains duplicate tools");
  }
  if (!actualMcpTools?.includes("ask_book")) errors.push("MCP tool contract is missing ask_book");

  if (JSON.stringify([...actualAgentLibrary].sort()) !== JSON.stringify(expectedAgent)) {
    errors.push(
      `router allowlist does not expose exactly ${expectedAgent.length} OneLibrary tools`,
    );
  }
  if (!actualAgentLibrary.includes("onelibrary__ask_book")) {
    errors.push("router allowlist is missing onelibrary__ask_book");
  }

  const forbiddenAgentEntries = new Set([
    "shell",
    "exec",
    "process",
    "write",
    "edit",
    "apply_patch",
    "browser",
  ]);
  const introducedForbidden = Array.isArray(actualAgentAllow)
    ? actualAgentAllow.filter((tool) => forbiddenAgentEntries.has(tool))
    : [];
  if (introducedForbidden.length > 0) {
    errors.push(
      `router allowlist exposes forbidden capability names: ${introducedForbidden.join(", ")}`,
    );
  }

  const loadedPaths = Array.isArray(config.plugins?.load?.paths) ? config.plugins.load.paths : [];
  if (!loadedPaths.some((value) => isPluginPath(value, contract, pluginDir))) {
    errors.push("deterministic-router is not present in plugins.load.paths");
  }
  if (config.plugins?.entries?.[contract.plugin_id]?.enabled !== true) {
    errors.push("deterministic-router is not enabled in persisted plugin config");
  }

  const pluginFiles = {
    manifest: join(pluginDir, "openclaw.plugin.json"),
    package: join(pluginDir, "package.json"),
    index: join(pluginDir, "index.ts"),
    knowledge: join(pluginDir, "knowledge.js"),
  };
  for (const [name, path] of Object.entries(pluginFiles)) {
    if (!existsSync(path)) errors.push(`runtime plugin file missing: ${name}`);
  }
  if (existsSync(pluginFiles.manifest)) {
    try {
      if (readJson(pluginFiles.manifest).id !== contract.plugin_id) {
        errors.push("runtime plugin manifest id does not match the contract");
      }
    } catch {
      errors.push("runtime plugin manifest is not valid JSON");
    }
  }
  if (existsSync(pluginFiles.index)) {
    const source = readFileSync(pluginFiles.index, "utf8");
    for (const marker of contract.required_guard_markers) {
      if (!source.includes(marker))
        errors.push(`runtime Knowledge Guard marker missing: ${marker}`);
    }
  }

  const instructionPath = join(workspaceDir, contract.workspace_instruction.split("/").at(-1));
  if (!existsSync(instructionPath)) {
    errors.push("router instruction file is missing");
  } else {
    const instructions = readFileSync(instructionPath, "utf8");
    for (const marker of [
      "onelibrary__ask_book",
      "Do not answer those questions from model memory",
      "terminal",
    ]) {
      if (!instructions.includes(marker))
        errors.push(`router instruction marker missing: ${marker}`);
    }
  }

  for (const path of collectBundleFiles(contract)) {
    if (!existsSync(path)) errors.push(`portable deployment artifact missing: ${path}`);
    else if (SECRET_VALUE_PATTERN.test(readFileSync(path, "utf8")))
      errors.push(`secret-like value found in ${path}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      schema_version: contract.schema_version,
      mcp_tool_count: Array.isArray(actualMcpTools) ? actualMcpTools.length : 0,
      ask_book: Array.isArray(actualMcpTools) && actualMcpTools.includes("ask_book"),
      router_tool_count: actualAgentLibrary.length,
      deterministic_router_loaded: loadedPaths.some((value) =>
        isPluginPath(value, contract, pluginDir),
      ),
      forbidden_one_library_write_tools: 0,
    },
  };
}

function redact(text) {
  return String(text || "")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api|gateway|telegram)[_-]?(?:key|token)\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]");
}

function runConfigPatch({ patch, configPath, stateDir, dryRun, openclawBin }) {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const result = spawnSync(
    openclawBin,
    ["config", "patch", "--stdin", ...(dryRun ? ["--dry-run"] : [])],
    {
      env,
      input: `${JSON.stringify(patch)}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `openclaw config patch failed: ${redact(result.stderr || result.stdout)}`.trim(),
    );
  }
}

function parseArgs(argv) {
  const [command = "validate", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--dry-run" || flag === "--json") {
      options[flag.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    const key = {
      "--state-dir": "stateDir",
      "--config": "configPath",
      "--workspace": "workspaceDir",
      "--plugin-dir": "pluginDir",
      "--openclaw-bin": "openclawBin",
    }[flag];
    if (!key || !rest[index + 1]) throw new Error(`unknown or incomplete option: ${flag}`);
    options[key] = rest[++index];
  }
  return { command, options };
}

function runCli() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const contract = readJson(CONTRACT_PATH);
  const paths = resolvePaths(options, contract);
  const config = existsSync(paths.configPath) ? readJson(paths.configPath) : {};

  if (command === "validate") {
    const result = validateContract({
      config,
      contract,
      pluginDir: paths.pluginDir,
      workspaceDir: paths.workspaceDir,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        `${result.ok ? "PASS" : "FAIL"} OneLibrary OpenClaw contract: ${JSON.stringify(result.summary)}`,
      );
    if (!result.ok) {
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command !== "apply")
    throw new Error(`unsupported command: ${command}; use validate or apply`);
  if (!existsSync(paths.configPath))
    throw new Error(
      `config does not exist: ${paths.configPath}; deployment does not invent MCP configuration`,
    );
  const patch = buildPatch(config, contract, paths);
  const openclawBin = options.openclawBin || process.env.OPENCLAW_BIN || "openclaw";
  if (!options.dry_run) {
    const sourcePluginDir = join(BUNDLE_ROOT, contract.plugin_directory);
    const sourceInstruction = join(BUNDLE_ROOT, contract.workspace_instruction);
    rmSync(paths.pluginDir, { recursive: true, force: true });
    mkdirSync(dirname(paths.pluginDir), { recursive: true });
    cpSync(sourcePluginDir, paths.pluginDir, { recursive: true });
    mkdirSync(paths.workspaceDir, { recursive: true });
    cpSync(sourceInstruction, join(paths.workspaceDir, "AGENTS.md"));
    runConfigPatch({
      patch,
      configPath: paths.configPath,
      stateDir: paths.stateDir,
      dryRun: true,
      openclawBin,
    });
    runConfigPatch({
      patch,
      configPath: paths.configPath,
      stateDir: paths.stateDir,
      dryRun: false,
      openclawBin,
    });
  } else if (existsSync(paths.pluginDir)) {
    runConfigPatch({
      patch,
      configPath: paths.configPath,
      stateDir: paths.stateDir,
      dryRun: true,
      openclawBin,
    });
  }
  const appliedConfig = options.dry_run ? config : readJson(paths.configPath);
  const result = validateContract({
    config: options.dry_run ? { ...config, ...patch } : appliedConfig,
    contract,
    pluginDir: paths.pluginDir,
    workspaceDir: paths.workspaceDir,
  });
  if (!result.ok && !options.dry_run) {
    for (const error of result.errors) console.error(`- ${error}`);
    throw new Error("applied OneLibrary contract did not validate");
  }
  if (options.json)
    console.log(
      JSON.stringify(
        {
          ...result,
          dry_run: Boolean(options.dry_run),
          paths: {
            state_dir: paths.stateDir,
            config: paths.configPath,
            workspace: paths.workspaceDir,
            plugin: paths.pluginDir,
          },
        },
        null,
        2,
      ),
    );
  else
    console.log(
      `${options.dry_run ? "DRY-RUN" : "PASS"} OneLibrary contract applied/validated: ${JSON.stringify(result.summary)}`,
    );
}

export { buildPatch, expectedAgentTools, readJson, resolvePaths, validateContract };

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
