import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "../..");
const packageDirectory = path.join(projectDirectory, "plugins", "skill-hoonsoo");

async function readJson(...segments) {
  return JSON.parse(await readFile(path.join(...segments), "utf8"));
}

async function listFiles(directory, relativeDirectory = "") {
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relativePath)));
    else files.push(relativePath);
  }
  return files.sort();
}

function requestOnce(child, method, params, timeoutMs = 3_000) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(line));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
  });
}

async function smokeTestMcp(server, host) {
  assert.equal(server.command, "node");
  const argumentsList = server.args.map((argument) =>
    argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", packageDirectory),
  );
  const cwd = host === "codex" ? path.resolve(packageDirectory, server.cwd) : tmpdir();
  const child = spawn(process.execPath, argumentsList, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const response = await requestOnce(child, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: `${host}-package-test`, version: "1.0.0" },
    });
    assert.equal(response.result.serverInfo.name, "hoonsoo", stderr);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

test("marketplaces point at the deterministic distribution package", async () => {
  const codexMarketplace = await readJson(projectDirectory, ".agents", "plugins", "marketplace.json");
  const claudeMarketplace = await readJson(projectDirectory, ".claude-plugin", "marketplace.json");

  assert.equal(codexMarketplace.name, "skill-hoonsoo");
  assert.equal(codexMarketplace.plugins[0].name, "skill-hoonsoo");
  assert.deepEqual(codexMarketplace.plugins[0].source, {
    source: "local",
    path: "./plugins/skill-hoonsoo",
  });
  assert.equal(claudeMarketplace.name, "skill-hoonsoo");
  assert.equal(claudeMarketplace.plugins[0].name, "skill-hoonsoo");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/skill-hoonsoo");
});

test("package contains only the install-time files", async () => {
  assert.deepEqual(await listFiles(packageDirectory), [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "claude.mcp.json",
    "scripts/hoonsoo-mcp.mjs",
    "skills/hoonsoo/SKILL.md",
    "skills/hoonsoo/agents/openai.yaml",
  ]);

  const codexManifest = await readJson(packageDirectory, ".codex-plugin", "plugin.json");
  const claudeManifest = await readJson(packageDirectory, ".claude-plugin", "plugin.json");
  assert.equal(codexManifest.name, "skill-hoonsoo");
  assert.equal(claudeManifest.name, codexManifest.name);
  assert.equal(claudeManifest.version, codexManifest.version);
  assert.equal(codexManifest.mcpServers.hoonsoo.cwd, ".");
  assert.equal(claudeManifest.mcpServers, "./claude.mcp.json");
});

test("Codex and Claude MCP configs start the packaged runtime", async () => {
  const codexManifest = await readJson(packageDirectory, ".codex-plugin", "plugin.json");
  const claudeConfig = await readJson(packageDirectory, "claude.mcp.json");
  assert.equal(codexManifest.mcpServers.hoonsoo.cwd, ".");
  assert.equal(claudeConfig.mcpServers.hoonsoo.cwd, undefined);
  await smokeTestMcp(codexManifest.mcpServers.hoonsoo, "codex");
  await smokeTestMcp(claudeConfig.mcpServers.hoonsoo, "claude");
});
