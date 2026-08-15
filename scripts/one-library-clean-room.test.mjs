import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const repoRoot = new URL("..", import.meta.url).pathname;
const stateDir = mkdtempSync(join(os.tmpdir(), "openclaw-one-library-clean-room-"));
const configPath = join(stateDir, "openclaw.json");
const workspaceDir = join(stateDir, "workspace-router");
const pluginDir = join(stateDir, "local-plugins", "deterministic-router");
const contractPath = join(repoRoot, "scripts", "one-library-contract.mjs");
const openclawEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
};

function gatewaySmoke(env) {
  return new Promise((resolve, reject) => {
    const gateway = spawn("openclaw", [
      "gateway",
      "run",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      "19099",
      "--auth",
      "none",
      "--ws-log",
      "compact",
    ], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const stop = () => {
      if (!gateway.killed) gateway.kill("SIGTERM");
      setTimeout(() => {
        if (!gateway.killed) gateway.kill("SIGKILL");
      }, 500);
    };
    gateway.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (/gateway|listening|ws:\/\//i.test(output)) stop();
    });
    gateway.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    gateway.on("error", finish);
    gateway.on("close", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") finish();
      else if (code === 0) finish();
      else finish(new Error(`clean-room gateway exited unexpectedly (${code ?? signal}): ${output}`));
    });
    const timer = setTimeout(() => {
      stop();
    }, 3000);
  });
}

try {
  writeFileSync(configPath, `${JSON.stringify({
    gateway: { mode: "local", bind: "loopback", port: 19099 },
    plugins: {},
    mcp: {
      servers: {
        onelibrary: {
          command: process.execPath,
          args: ["-e", "process.stdin.resume()"],
          toolFilter: { include: ["ask_book"] },
        },
      },
    },
    agents: {
      entries: {
        "telegram-router": { tools: { allow: ["sessions_spawn"] } },
      },
    },
  }, null, 2)}\n`);

  execFileSync(process.execPath, [contractPath, "apply", "--state-dir", stateDir, "--config", configPath, "--workspace", workspaceDir, "--plugin-dir", pluginDir], {
    cwd: repoRoot,
    env: openclawEnv,
    stdio: "pipe",
  });

  const validation = execFileSync(process.execPath, [contractPath, "validate", "--state-dir", stateDir, "--config", configPath, "--workspace", workspaceDir, "--plugin-dir", pluginDir, "--json"], {
    cwd: repoRoot,
    env: openclawEnv,
    encoding: "utf8",
  });
  const result = JSON.parse(validation);
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(result.summary.mcp_tool_count, 12);
  assert.equal(result.summary.ask_book, true);
  assert.equal(result.summary.router_tool_count, 12);

  const configCheck = execFileSync("openclaw", ["config", "validate"], {
    cwd: repoRoot,
    env: openclawEnv,
    encoding: "utf8",
  });
  assert.match(configCheck, /Config valid/);

  const plugins = JSON.parse(execFileSync("openclaw", ["plugins", "list", "--json"], {
    cwd: repoRoot,
    env: openclawEnv,
    encoding: "utf8",
  }));
  const deterministic = plugins.plugins.find((plugin) => plugin.id === "deterministic-router");
  assert.equal(deterministic?.status, "loaded");
  assert.equal(deterministic?.enabled, true);

  const gatewayOutput = await gatewaySmoke(openclawEnv);
  assert.match(gatewayOutput, /gateway|listening|ws:\/\//i);

  // Simulate a package replacement that removes the generated local plugin
  // directory. The documented apply step must recreate it from the bundle.
  rmSync(pluginDir, { recursive: true, force: true });
  execFileSync(process.execPath, [contractPath, "apply", "--state-dir", stateDir, "--config", configPath, "--workspace", workspaceDir, "--plugin-dir", pluginDir], {
    cwd: repoRoot,
    env: openclawEnv,
    stdio: "pipe",
  });
  const recovered = JSON.parse(execFileSync(process.execPath, [contractPath, "validate", "--state-dir", stateDir, "--config", configPath, "--workspace", workspaceDir, "--plugin-dir", pluginDir, "--json"], {
    cwd: repoRoot,
    env: openclawEnv,
    encoding: "utf8",
  }));
  assert.equal(recovered.ok, true, recovered.errors?.join("; "));
  assert.equal(recovered.summary.mcp_tool_count, 12);
  assert.equal(recovered.summary.ask_book, true);
  const recoveredPlugins = JSON.parse(execFileSync("openclaw", ["plugins", "list", "--json"], {
    cwd: repoRoot,
    env: openclawEnv,
    encoding: "utf8",
  }));
  const recoveredDeterministic = recoveredPlugins.plugins.find((plugin) => plugin.id === "deterministic-router");
  assert.equal(recoveredDeterministic?.status, "loaded");

  console.log("one-library clean-room deployment checks passed");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
