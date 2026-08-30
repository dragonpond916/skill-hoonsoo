import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "../..");
const serverScript = path.join(projectDirectory, "scripts", "hoonsoo-mcp.mjs");
const temporaryDirectories = [];
const clients = [];

class JsonRpcClient {
  constructor() {
    this.process = spawn(process.execPath, [serverScript], {
      cwd: projectDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.process.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`MCP server exited before responding (code=${code}, signal=${signal}): ${this.stderr}`),
        );
      }
      this.pending.clear();
    });
  }

  request(method, params = undefined, timeoutMs = 3_000) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params = undefined) {
    const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    return this.closePromise;
  }

  async #close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP test client closed before receiving a response"));
    }
    this.pending.clear();

    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.stdin.end();
      if (!(await this.#waitForExit(500))) {
        this.process.kill("SIGTERM");
        if (!(await this.#waitForExit(500))) {
          this.process.kill("SIGKILL");
          await this.#waitForExit(500);
        }
      }
    }

    this.lines.close();
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.process.unref();
  }

  #waitForExit(timeoutMs) {
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.process.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.process.once("exit", onExit);
    });
  }
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "hoonsoo-mcp-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("serves the MCP lifecycle and all read-only tools over JSONL stdio", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "large-document.md");
  await writeFile(target, "x".repeat(100_000), "utf8");
  const client = new JsonRpcClient();
  clients.push(client);

  const initialize = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "hoonsoo-test", version: "1.0.0" },
  });
  assert.equal(initialize.result.protocolVersion, "2024-11-05");
  assert.equal(initialize.result.serverInfo.name, "hoonsoo");
  assert.equal(initialize.result.serverInfo.version, "0.2.0");
  assert.deepEqual(initialize.result.capabilities, { tools: { listChanged: false } });
  client.notify("notifications/initialized");

  const ping = await client.request("ping");
  assert.deepEqual(ping.result, {});

  const listed = await client.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["start_monitor", "read_snapshot", "wait_for_change", "get_status", "stop_monitor"],
  );
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  const startDefinition = listed.result.tools.find((tool) => tool.name === "start_monitor");
  assert.equal(startDefinition.inputSchema.properties.settleMs.default, 3_000);
  const waitDefinition = listed.result.tools.find((tool) => tool.name === "wait_for_change");
  assert.equal(
    Object.hasOwn(waitDefinition.inputSchema.properties.timeoutMs, "default"),
    false,
  );
  assert.match(waitDefinition.description, /Omit timeoutMs/);

  const startCall = await client.request("tools/call", {
    name: "start_monitor",
    arguments: { path: target, pollIntervalMs: 25, settleMs: 10 },
  });
  assert.equal(startCall.result.isError, undefined);
  const started = startCall.result.structuredContent;
  assert.equal(started.status, "active");
  assert.equal(started.revision, 0);

  const snapshotCall = await client.request("tools/call", {
    name: "read_snapshot",
    arguments: { monitorId: started.monitorId },
  });
  const snapshot = snapshotCall.result.structuredContent;
  assert.equal(snapshot.content.length, 32_000);
  assert.equal(snapshot.pagination.totalCharacters, 100_000);
  assert.equal(snapshot.pagination.nextOffset, 32_000);
  assert.equal(snapshot.pagination.hasMore, true);
  assert.ok(JSON.stringify(snapshotCall).length < 100_000);

  const statusCall = await client.request("tools/call", {
    name: "get_status",
    arguments: { monitorId: started.monitorId },
  });
  assert.equal(statusCall.result.structuredContent.monitorId, started.monitorId);

  const waitCall = await client.request("tools/call", {
    name: "wait_for_change",
    arguments: { monitorId: started.monitorId, afterRevision: 0, timeoutMs: 0 },
  });
  assert.equal(waitCall.result.structuredContent.state, "timeout");

  await writeFile(target, `${"x".repeat(99_999)}y`, "utf8");
  const changedCall = await client.request(
    "tools/call",
    {
      name: "wait_for_change",
      arguments: { monitorId: started.monitorId, afterRevision: 0, timeoutMs: 3_000 },
    },
    5_000,
  );
  assert.equal(changedCall.result.structuredContent.state, "changed");
  assert.equal(changedCall.result.structuredContent.event.type, "changed");
  assert.equal(changedCall.result.structuredContent.event.revision, 1);

  const changedSnapshotCall = await client.request("tools/call", {
    name: "read_snapshot",
    arguments: { monitorId: started.monitorId, offset: 99_999, maxCharacters: 1 },
  });
  assert.equal(changedSnapshotCall.result.structuredContent.revision, 1);
  assert.equal(changedSnapshotCall.result.structuredContent.content, "y");

  const stopCall = await client.request("tools/call", {
    name: "stop_monitor",
    arguments: { monitorId: started.monitorId },
  });
  assert.equal(stopCall.result.structuredContent.status, "stopped");
  assert.equal(stopCall.result.structuredContent.reason, "user-stopped");
});

test("returns tool errors without terminating the MCP server", async () => {
  const client = new JsonRpcClient();
  clients.push(client);
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hoonsoo-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const badCall = await client.request("tools/call", {
    name: "start_monitor",
    arguments: { path: "relative.md" },
  });
  assert.equal(badCall.result.isError, true);
  assert.equal(badCall.result.structuredContent.error.code, "INVALID_PATH");

  const ping = await client.request("ping");
  assert.deepEqual(ping.result, {});
});

test("honors JSON-RPC cancellation for a long wait", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const client = new JsonRpcClient();
  clients.push(client);
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hoonsoo-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");
  const startCall = await client.request("tools/call", {
    name: "start_monitor",
    arguments: { path: target, pollIntervalMs: 25 },
  });
  const monitorId = startCall.result.structuredContent.monitorId;

  const requestId = client.nextId;
  const waiting = client.request(
    "tools/call",
    {
      name: "wait_for_change",
      arguments: { monitorId, afterRevision: 0, timeoutMs: 50_000 },
    },
    3_000,
  );
  client.notify("notifications/cancelled", { requestId, reason: "test cancellation" });
  const cancelled = await waiting;
  assert.equal(cancelled.result.structuredContent.state, "cancelled");
});
