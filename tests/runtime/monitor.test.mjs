import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_DELTA_CHARACTERS,
  MAX_FILE_BYTES,
  MonitorSession,
  computeLineDelta,
  normalizeTargetPath,
} from "../../scripts/hoonsoo-mcp.mjs";

const temporaryDirectories = [];
const sessions = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "hoonsoo-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const session of sessions) session.close();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("normalizes only absolute paths", () => {
  const absolute = path.join(tmpdir(), "folder", "..", "document.md");
  assert.equal(normalizeTargetPath(absolute), path.join(tmpdir(), "document.md"));
  assert.throws(() => normalizeTargetPath("relative.md"), { code: "INVALID_PATH" });
});

test("computes a bounded line delta with surrounding context", () => {
  const delta = computeLineDelta("first\nsecond\nthird", "first\nSECOND\nthird", 1);

  assert.equal(delta.algorithm, "bounded-lcs-line");
  assert.equal(delta.additions, 1);
  assert.equal(delta.deletions, 1);
  assert.equal(delta.truncated, false);
  assert.deepEqual(
    delta.hunks[0].lines.map(({ type, text }) => [type, text]),
    [
      ["context", "first"],
      ["delete", "second"],
      ["add", "SECOND"],
      ["context", "third"],
    ],
  );
});

test("uses bounded fallbacks and caps serialized delta payloads", () => {
  const previous = Array.from({ length: 2_000 }, (_, index) => `old-${index}`).join("\n");
  const current = Array.from({ length: 2_000 }, (_, index) => `new-${index}`).join("\n");
  const coarse = computeLineDelta(previous, current, 5);

  assert.equal(coarse.algorithm, "bounded-line-replacement");
  assert.equal(coarse.truncated, true);
  assert.equal(coarse.truncationReason, "lcs-cell-limit");
  assert.ok(JSON.stringify(coarse).length <= MAX_DELTA_CHARACTERS);

  const manyLines = computeLineDelta("old\n".repeat(100_001), "new\n".repeat(100_001), 5);
  assert.equal(manyLines.truncated, true);
  assert.equal(manyLines.truncationReason, "line-count-limit");
  assert.ok(JSON.stringify(manyLines).length <= MAX_DELTA_CHARACTERS);

  const longLine = computeLineDelta("a".repeat(100_000), "b".repeat(100_000), 5);
  assert.equal(longLine.truncated, true);
  assert.ok(JSON.stringify(longLine).length <= MAX_DELTA_CHARACTERS);
});

test("starts idempotently and pages the in-memory snapshot", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "0123456789", "utf8");
  const session = new MonitorSession();
  sessions.push(session);

  const started = await session.startMonitor({
    path: target,
    pollIntervalMs: 25,
    settleMs: 10,
    contextLines: 2,
  });
  assert.equal(started.revision, 0);
  assert.equal(started.status, "active");
  assert.equal(started.reused, false);

  const reused = await session.startMonitor({
    path: target,
    pollIntervalMs: 30,
    settleMs: 5,
    contextLines: 1,
  });
  assert.equal(reused.monitorId, started.monitorId);
  assert.equal(reused.reused, true);

  const first = session.readSnapshot({ monitorId: started.monitorId, offset: 0, maxCharacters: 4 });
  assert.equal(first.content, "0123");
  assert.deepEqual(first.pagination, {
    offset: 0,
    returnedCharacters: 4,
    totalCharacters: 10,
    nextOffset: 4,
    hasMore: true,
  });
  const last = session.readSnapshot({
    monitorId: started.monitorId,
    offset: first.pagination.nextOffset,
    maxCharacters: 20,
  });
  assert.equal(last.content, "456789");
  assert.equal(last.pagination.hasMore, false);
  assert.equal(last.pagination.nextOffset, null);
});

test("rejects non-files, oversized files, and invalid UTF-8", async () => {
  const directory = await temporaryDirectory();
  const nestedDirectory = path.join(directory, "nested");
  const oversized = path.join(directory, "oversized.txt");
  const invalidUtf8 = path.join(directory, "invalid.txt");
  await mkdir(nestedDirectory);
  await writeFile(oversized, Buffer.alloc(MAX_FILE_BYTES + 1));
  await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
  const session = new MonitorSession();
  sessions.push(session);

  await assert.rejects(() => session.startMonitor({ path: nestedDirectory }), {
    code: "TARGET_NOT_REGULAR_FILE",
  });
  await assert.rejects(() => session.startMonitor({ path: oversized }), {
    code: "TARGET_TOO_LARGE",
  });
  await assert.rejects(() => session.startMonitor({ path: invalidUtf8 }), {
    code: "TARGET_NOT_UTF8",
  });
});

test("emits a changed event and advances the snapshot revision", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "alpha\nbeta\ngamma", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 15 });

  await writeFile(target, "alpha\nBETA\ngamma", "utf8");
  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 2_000,
  });

  assert.equal(result.state, "changed");
  assert.equal(result.event.type, "changed");
  assert.equal(result.event.revision, 1);
  assert.equal(result.event.delta.additions, 1);
  assert.equal(result.event.delta.deletions, 1);
  assert.equal(result.rebaselineRequired, false);
  assert.equal(
    session.readSnapshot({ monitorId: started.monitorId }).content,
    "alpha\nBETA\ngamma",
  );
  assert.equal(await readFile(target, "utf8"), "alpha\nBETA\ngamma");
});

test("does not advance the revision for a metadata-only write", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "unchanged", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 10 });

  await writeFile(target, "unchanged", "utf8");
  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 250,
  });
  assert.equal(result.state, "timeout");
  assert.equal(session.getStatus({ monitorId: started.monitorId }).revision, 0);
});

test("distinguishes atomic replacement from an in-place change", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  const replacement = path.join(directory, "replacement.md");
  await writeFile(target, "before", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 15 });

  await writeFile(replacement, "after", "utf8");
  await rename(replacement, target);
  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 2_000,
  });

  assert.equal(result.state, "changed");
  assert.equal(result.event.type, "replaced");
  assert.equal(result.event.revision, 1);
});

test("emits deletion and stops the monitor", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "temporary", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 15 });

  await unlink(target);
  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 2_000,
  });

  assert.equal(result.state, "changed");
  assert.equal(result.event.type, "deleted");
  assert.equal(result.event.revision, 1);
  const status = session.getStatus({ monitorId: started.monitorId });
  assert.equal(status.status, "stopped");
  assert.equal(status.reason, "target-deleted");
});

test("stopping resolves pending waits and future revisions are rejected", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });

  assert.throws(
    () =>
      session.waitForChange({
        monitorId: started.monitorId,
        afterRevision: 1,
        timeoutMs: 0,
      }),
    { code: "REVISION_AHEAD" },
  );

  const pending = session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 2_000,
  });
  session.stopMonitor({ monitorId: started.monitorId });
  const result = await pending;
  assert.equal(result.state, "stopped");
  assert.equal(result.reason, "user-stopped");
});

test("marks pruned event history as requiring a snapshot rebaseline", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  const monitor = session.monitors.get(started.monitorId);
  monitor.revision = 70;
  monitor.events = Array.from({ length: 64 }, (_, index) => ({
    type: "changed",
    monitorId: monitor.id,
    revision: index + 7,
  }));

  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 0,
  });
  assert.equal(result.historyTruncated, true);
  assert.equal(result.rebaselineRequired, true);
  assert.equal(result.event.revision, 7);
});
