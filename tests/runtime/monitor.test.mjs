import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  IDLE_WARNING_MESSAGE,
  MAX_DELTA_CHARACTERS,
  MAX_FILE_BYTES,
  MonitorSession,
  computeLineDelta,
  computeMeaningfulLineDelta,
  normalizeMeaningfulText,
  normalizeTargetPath,
} from "../../scripts/hoonsoo-mcp.mjs";

const temporaryDirectories = [];
const sessions = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "hoonsoo-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function withDeadline(promise, milliseconds = 1_000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(milliseconds, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Timed out after ${milliseconds} ms`);
      }),
    ]);
  } finally {
    controller.abort();
  }
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

test("normalizes whitespace-only changes out of meaningful comparison and deltas", () => {
  const previous = "alpha beta\ngamma";
  const reformatted = "\talpha   beta\n\n  gamma\n";

  assert.equal(normalizeMeaningfulText(previous), normalizeMeaningfulText(reformatted));
  const delta = computeMeaningfulLineDelta(previous, reformatted, 2);
  assert.equal(delta.additions, 0);
  assert.equal(delta.deletions, 0);
  assert.deepEqual(delta.hunks, []);
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

test("ignores whitespace-only writes and keeps the revision snapshot stable", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  const baseline = "alpha beta\ngamma";
  await writeFile(target, baseline, "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 20 });

  await writeFile(target, "\talpha   beta\n\n gamma\n", "utf8");
  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 250,
  });

  assert.equal(result.state, "timeout");
  assert.equal(session.getStatus({ monitorId: started.monitorId }).revision, 0);
  assert.equal(session.readSnapshot({ monitorId: started.monitorId }).content, baseline);
});

test("coalesces repeated meaningful writes until the quiet window elapses", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "version zero", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 120 });

  await writeFile(target, "version one", "utf8");
  await delay(70);
  await writeFile(target, "version two", "utf8");
  await delay(80);
  assert.equal(session.getStatus({ monitorId: started.monitorId }).revision, 0);

  const result = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 500,
  });
  assert.equal(result.state, "changed");
  assert.equal(result.event.revision, 1);
  assert.equal(session.readSnapshot({ monitorId: started.monitorId }).content, "version two");
});

test("returns the latest net delta from the last handled analysis revision", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "alpha", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 15 });

  await writeFile(target, "bravo", "utf8");
  const first = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 500,
  });
  assert.equal(first.event.revision, 1);

  await writeFile(target, "charlie", "utf8");
  await delay(100);
  assert.equal(session.getStatus({ monitorId: started.monitorId }).revision, 2);

  const accumulated = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 0,
  });
  assert.equal(accumulated.event.revision, 2);
  assert.equal(accumulated.event.previousRevision, 0);
  assert.equal(accumulated.event.fromRevision, 0);
  assert.equal(accumulated.event.delta.additions, 1);
  assert.equal(accumulated.event.delta.deletions, 1);
  assert.ok(accumulated.event.changedRanges.length > 0);
  assert.equal("lines" in accumulated.event.delta.hunks[0], false);

  const acknowledged = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 2,
    timeoutMs: 0,
  });
  assert.equal(acknowledged.state, "timeout");
  assert.equal(session.getStatus({ monitorId: started.monitorId }).analysisBaselineRevision, 2);

  await writeFile(target, "delta", "utf8");
  const next = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 2,
    timeoutMs: 500,
  });
  assert.equal(next.event.previousRevision, 2);
  assert.equal(next.event.fromRevision, 2);
  assert.equal(next.event.delta.additions, 1);
  assert.equal(next.event.delta.deletions, 1);
});

test("does not redeliver an older revision while a newer meaningful change is settling", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "zero", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 100 });

  await writeFile(target, "one", "utf8");
  const first = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 500,
  });
  assert.equal(first.event.revision, 1);

  await writeFile(target, "two", "utf8");
  await delay(40);
  assert.equal(
    session.getStatus({ monitorId: started.monitorId }).pendingMeaningfulChange,
    true,
  );
  const latest = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 500,
  });
  assert.equal(latest.event.revision, 2);
  assert.equal(latest.event.previousRevision, 0);
});

test("emits one idle warning and automatically stops at the idle deadline", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const session = new MonitorSession({ idleWarningMs: 60, idleStopMs: 110 });
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 10 });

  const warning = await withDeadline(
    session.waitForChange({
      monitorId: started.monitorId,
      afterRevision: 0,
    }),
  );
  assert.equal(warning.state, "idle-warning");
  assert.equal(warning.message, IDLE_WARNING_MESSAGE);
  assert.equal(warning.revision, 0);

  const stopped = await withDeadline(
    session.waitForChange({
      monitorId: started.monitorId,
      afterRevision: 0,
    }),
  );
  assert.equal(stopped.state, "idle-stopped");
  assert.equal(stopped.reason, "idle-timeout");
  assert.equal(session.getStatus({ monitorId: started.monitorId }).status, "stopped");
});

test("a meaningful change after the idle warning resets the idle lifecycle", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "before", "utf8");
  const session = new MonitorSession({ idleWarningMs: 70, idleStopMs: 130 });
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 10 });

  const warning = await withDeadline(
    session.waitForChange({ monitorId: started.monitorId, afterRevision: 0 }),
  );
  assert.equal(warning.state, "idle-warning");
  await writeFile(target, "after", "utf8");
  const changed = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 500,
  });
  assert.equal(changed.state, "changed");

  const newWarning = await session.waitForChange({
    monitorId: started.monitorId,
    afterRevision: changed.event.revision,
    timeoutMs: 500,
  });
  assert.equal(newWarning.state, "idle-warning");
  assert.equal(session.getStatus({ monitorId: started.monitorId }).status, "active");
});

test("whitespace-only writes do not reset the idle clock", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "alpha beta", "utf8");
  const session = new MonitorSession({ idleWarningMs: 100, idleStopMs: 190 });
  sessions.push(session);
  const startedAt = Date.now();
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25, settleMs: 10 });

  await delay(55);
  await writeFile(target, "alpha\t beta\n", "utf8");
  const warning = await withDeadline(
    session.waitForChange({ monitorId: started.monitorId, afterRevision: 0 }),
  );

  assert.equal(warning.state, "idle-warning");
  assert.ok(Date.now() - startedAt < 145, "whitespace-only activity unexpectedly reset idle time");
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

test("coalesces pruned event history to the latest revision and requires rebaseline", async () => {
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
  assert.equal(result.event.revision, 70);
});
