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
const packageDirectory = path.join(projectDirectory, "plugins", "skill-sherpa");
const expectedVersion = "0.6.0";
const canonicalRepository = "https://github.com/dragonpond916/skill-sherpa";
const legacyIdentity = /hoonsoo|훈수/iu;

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
    assert.equal(response.result.serverInfo.name, "sherpa", stderr);
    assert.equal(response.result.serverInfo.version, expectedVersion, stderr);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

test("marketplaces point at the deterministic distribution package", async () => {
  const codexMarketplace = await readJson(projectDirectory, ".agents", "plugins", "marketplace.json");
  const claudeMarketplace = await readJson(projectDirectory, ".claude-plugin", "marketplace.json");

  assert.equal(codexMarketplace.name, "skill-sherpa");
  assert.equal(codexMarketplace.plugins[0].name, "skill-sherpa");
  assert.deepEqual(codexMarketplace.plugins[0].source, {
    source: "local",
    path: "./plugins/skill-sherpa",
  });
  assert.equal(claudeMarketplace.name, "skill-sherpa");
  assert.equal(claudeMarketplace.plugins[0].name, "skill-sherpa");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/skill-sherpa");
});

test("package contains only the install-time files", async () => {
  const packagedFiles = await listFiles(packageDirectory);
  assert.deepEqual(packagedFiles, [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "claude.mcp.json",
    "scripts/sherpa-mcp.mjs",
    "skills/sherpa/SKILL.md",
    "skills/sherpa/agents/openai.yaml",
  ]);

  const codexManifest = await readJson(packageDirectory, ".codex-plugin", "plugin.json");
  const claudeManifest = await readJson(packageDirectory, ".claude-plugin", "plugin.json");
  assert.equal(codexManifest.name, "skill-sherpa");
  assert.equal(claudeManifest.name, codexManifest.name);
  assert.equal(codexManifest.version, expectedVersion);
  assert.equal(claudeManifest.version, codexManifest.version);
  assert.equal(codexManifest.homepage, canonicalRepository);
  assert.equal(codexManifest.repository, canonicalRepository);
  assert.equal(claudeManifest.homepage, canonicalRepository);
  assert.equal(claudeManifest.repository, canonicalRepository);
  assert.equal(codexManifest.mcpServers.sherpa.cwd, ".");
  assert.equal(claudeManifest.mcpServers, "./claude.mcp.json");

  for (const relativePath of packagedFiles) {
    const content = await readFile(path.join(packageDirectory, relativePath), "utf8");
    assert.doesNotMatch(
      content,
      legacyIdentity,
      `legacy identity remains in ${relativePath}`,
    );
  }
});

test("Codex and Claude MCP configs start the packaged runtime", async () => {
  const codexManifest = await readJson(packageDirectory, ".codex-plugin", "plugin.json");
  const claudeConfig = await readJson(packageDirectory, "claude.mcp.json");
  assert.equal(codexManifest.mcpServers.sherpa.cwd, ".");
  assert.equal(claudeConfig.mcpServers.sherpa.cwd, undefined);
  await smokeTestMcp(codexManifest.mcpServers.sherpa, "codex");
  await smokeTestMcp(claudeConfig.mcpServers.sherpa, "claude");
});
