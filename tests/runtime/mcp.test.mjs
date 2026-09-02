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
const serverScript = path.join(projectDirectory, "scripts", "sherpa-mcp.mjs");
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
  const directory = await mkdtemp(path.join(tmpdir(), "sherpa-mcp-test-"));
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

test("serves the 0.5.0 six-tool inline review lifecycle over JSONL stdio", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "large-document.md");
  await writeFile(target, "x".repeat(100_000), "utf8");
  const client = new JsonRpcClient();
  clients.push(client);

  const initialize = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sherpa-test", version: "1.0.0" },
  });
  assert.equal(initialize.result.protocolVersion, "2024-11-05");
  assert.equal(initialize.result.serverInfo.name, "sherpa");
  assert.equal(initialize.result.serverInfo.version, "0.5.0");
  assert.deepEqual(initialize.result.capabilities, { tools: { listChanged: false } });
  assert.match(initialize.result.instructions.slice(0, 512), /six tools/i);
  assert.match(initialize.result.instructions.slice(0, 512), /current host/i);
  assert.match(initialize.result.instructions.slice(0, 512), /do not use subagents/i);
  client.notify("notifications/initialized");

  const ping = await client.request("ping");
  assert.deepEqual(ping.result, {});

  const listed = await client.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "start_monitor",
      "read_review_context",
      "publish_feedback",
      "wait_for_save",
      "get_status",
      "stop_monitor",
    ],
  );
  const sessionMemoryStores = new Set(["read_review_context", "publish_feedback"]);
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, !sessionMemoryStores.has(tool.name));
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  const startDefinition = listed.result.tools.find((tool) => tool.name === "start_monitor");
  assert.deepEqual(startDefinition.inputSchema.required, ["path"]);
  assert.equal(Object.hasOwn(startDefinition.inputSchema.properties, "settleMs"), false);
  assert.equal(startDefinition.inputSchema.properties.prompt.maxLength, 8_000);
  assert.equal(startDefinition.inputSchema.properties.pollIntervalMs.default, 250);
  const waitDefinition = listed.result.tools.find((tool) => tool.name === "wait_for_save");
  assert.equal(
    Object.hasOwn(waitDefinition.inputSchema.properties.timeoutMs, "default"),
    false,
  );

  const startCall = await client.request("tools/call", {
    name: "start_monitor",
    arguments: { path: target, prompt: "Review content and grammar." },
  });
  assert.equal(startCall.result.isError, undefined);
  const started = startCall.result.structuredContent;
  assert.equal(started.status, "active");
  assert.equal(started.revision, 0);
  assert.equal(started.pollIntervalMs, 250);
  assert.match(started.promptRef, /^prompt-monitor-\d+-[a-f0-9]{16}$/);
  const compactStart = JSON.parse(startCall.result.content[0].text);
  assert.equal(compactStart.monitorId, started.monitorId);
  assert.equal(Object.hasOwn(compactStart, "path"), false);

  const contextCall = await client.request("tools/call", {
    name: "read_review_context",
    arguments: { monitorId: started.monitorId },
  });
  const context = contextCall.result.structuredContent;
  assert.equal(context.state, "review-ready");
  assert.equal(context.revision, 0);
  assert.equal(context.contentHash, started.contentHash);
  assert.equal(context.sourceKind, "revision");
  assert.equal(context.sourceArtifactId, started.revisionArtifactId);
  assert.equal(context.prompt, "Review content and grammar.");
  assert.equal(context.excerpt.content.length, 12_000);
  assert.equal(context.documentContext.content.length, 32_000);
  assert.equal(context.documentContext.totalCharacters, 100_000);
  assert.equal(context.documentContext.truncated, true);
  assert.match(context.reviewToken, /^review-/);
  const compactContext = JSON.parse(contextCall.result.content[0].text);
  assert.equal(compactContext.reviewToken, context.reviewToken);
  assert.equal(Object.hasOwn(compactContext, "excerpt"), false);
  assert.equal(Object.hasOwn(compactContext, "documentContext"), false);
  assert.ok(contextCall.result.content[0].text.length < 1_000);

  const reusedContextCall = await client.request("tools/call", {
    name: "read_review_context",
    arguments: { monitorId: started.monitorId, revision: 0 },
  });
  assert.equal(reusedContextCall.result.structuredContent.reviewToken, context.reviewToken);
  assert.equal(reusedContextCall.result.structuredContent.leaseExpiresAt, context.leaseExpiresAt);
  assert.equal(reusedContextCall.result.structuredContent.reused, true);

  const publishCall = await client.request("tools/call", {
    name: "publish_feedback",
    arguments: {
      monitorId: started.monitorId,
      reviewToken: context.reviewToken,
      revision: context.revision,
      contentHash: context.contentHash,
      feedback: "Natural-language baseline feedback",
    },
  });
  const published = publishCall.result.structuredContent;
  assert.equal(published.state, "published");
  assert.equal(published.fieldArtifactId, null);
  assert.equal(published.publishedRevision, 0);
  assert.equal(published.feedback, "Natural-language baseline feedback");
  const compactPublished = JSON.parse(publishCall.result.content[0].text);
  assert.equal(compactPublished.feedbackArtifactId, published.feedbackArtifactId);
  assert.equal(Object.hasOwn(compactPublished, "feedback"), false);

  const statusCall = await client.request("tools/call", {
    name: "get_status",
    arguments: { monitorId: started.monitorId },
  });
  assert.equal(statusCall.result.structuredContent.monitorId, started.monitorId);
  assert.equal(statusCall.result.structuredContent.reviewLease.active, false);

  const waitCall = await client.request("tools/call", {
    name: "wait_for_save",
    arguments: { monitorId: started.monitorId, afterRevision: 0, timeoutMs: 0 },
  });
  assert.equal(waitCall.result.structuredContent.state, "timeout");

  const savedAt = Date.now();
  await writeFile(target, `${"x".repeat(99_999)}y`, "utf8");
  const changedCall = await client.request(
    "tools/call",
    {
      name: "wait_for_save",
      arguments: { monitorId: started.monitorId, afterRevision: 0, timeoutMs: 3_000 },
    },
    5_000,
  );
  assert.equal(changedCall.result.structuredContent.state, "saved");
  assert.equal(changedCall.result.structuredContent.event.type, "changed");
  assert.equal(changedCall.result.structuredContent.event.revision, 1);
  assert.ok(Date.now() - savedAt < 750, "default polling did not detect the save quickly");

  const changed = changedCall.result.structuredContent.event;
  const changedContextCall = await client.request("tools/call", {
    name: "read_review_context",
    arguments: { monitorId: started.monitorId, revision: 1 },
  });
  const changedContext = changedContextCall.result.structuredContent;
  assert.equal(changedContext.sourceKind, "diff");
  assert.equal(changedContext.sourceArtifactId, changed.diffArtifactId);
  assert.equal(changedContext.recentPublishedFeedback.length, 1);
  assert.equal(changedContext.recentPublishedFeedback[0].revision, 0);

  const changedPublishCall = await client.request("tools/call", {
    name: "publish_feedback",
    arguments: {
      monitorId: started.monitorId,
      reviewToken: changedContext.reviewToken,
      revision: 1,
      contentHash: changed.contentHash,
      feedback: "Natural-language revision feedback",
    },
  });
  assert.equal(changedPublishCall.result.structuredContent.publishedRevision, 1);

  const hiddenToolCall = await client.request("tools/call", {
    name: "read_revision",
    arguments: { monitorId: started.monitorId, revision: 1 },
  });
  assert.equal(hiddenToolCall.result.isError, true);
  assert.equal(hiddenToolCall.result.structuredContent.error.code, "TOOL_NOT_FOUND");

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
    clientInfo: { name: "sherpa-test", version: "1.0.0" },
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
    clientInfo: { name: "sherpa-test", version: "1.0.0" },
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
      name: "wait_for_save",
      arguments: { monitorId, afterRevision: 0, timeoutMs: 50_000 },
    },
    3_000,
  );
  client.notify("notifications/cancelled", { requestId, reason: "test cancellation" });
  const cancelled = await waiting;
  assert.equal(cancelled.result.structuredContent.state, "cancelled");
});
