import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_REVIEW_LEASE_MS,
  IDLE_WARNING_MESSAGE,
  MAX_DELTA_CHARACTERS,
  MAX_FILE_BYTES,
  MonitorSession,
  computeContentHash,
  computeLineDelta,
  normalizeTargetPath,
} from "../../scripts/sherpa-mcp.mjs";

const temporaryDirectories = [];
const sessions = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "sherpa-runtime-test-"));
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

async function waitUntil(predicate, milliseconds = 1_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`Condition was not met within ${milliseconds} ms`);
}

async function waitForSaved(session, monitorId, afterRevision, milliseconds = 1_000) {
  const result = await session.waitForSave({
    monitorId,
    afterRevision,
    timeoutMs: milliseconds,
  });
  assert.equal(result.state, "saved");
  return result;
}

after(async () => {
  for (const session of sessions) session.close();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("normalizes only absolute paths and hashes raw whitespace", () => {
  const absolute = path.join(tmpdir(), "folder", "..", "document.md");
  assert.equal(normalizeTargetPath(absolute), path.join(tmpdir(), "document.md"));
  assert.throws(() => normalizeTargetPath("relative.md"), { code: "INVALID_PATH" });
  assert.notEqual(computeContentHash("alpha beta"), computeContentHash("alpha  beta"));
});

test("computes bounded line deltas with context and payload caps", () => {
  const delta = computeLineDelta("first\nsecond\nthird", "first\nSECOND\nthird", 1);
  assert.equal(delta.algorithm, "bounded-lcs-line");
  assert.equal(delta.additions, 1);
  assert.equal(delta.deletions, 1);
  assert.deepEqual(
    delta.hunks[0].lines.map(({ type, text }) => [type, text]),
    [
      ["context", "first"],
      ["delete", "second"],
      ["add", "SECOND"],
      ["context", "third"],
    ],
  );
  const previous = Array.from({ length: 2_000 }, (_, index) => `old-${index}`).join("\n");
  const current = Array.from({ length: 2_000 }, (_, index) => `new-${index}`).join("\n");
  const bounded = computeLineDelta(previous, current, 5);
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length <= MAX_DELTA_CHARACTERS);
});

test("starts with a versioned baseline and reads exact revision pages", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "0123456789", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({
    path: target,
    prompt: "Review content and grammar.",
    pollIntervalMs: 25,
    contextLines: 2,
  });
  assert.equal(started.revision, 0);
  assert.equal(started.saveSequence, 0);
  assert.equal(started.revisionArtifactId, `revision-${started.monitorId}-0`);
  assert.equal(started.promptPresent, true);
  assert.match(started.promptRef, /^prompt-monitor-\d+-[a-f0-9]{16}$/);
  assert.equal("settleMs" in started, false);

  const first = session.readRevision({
    monitorId: started.monitorId,
    revision: 0,
    offset: 0,
    maxCharacters: 4,
  });
  assert.equal(first.content, "0123");
  assert.equal(first.contentHash, started.contentHash);
  assert.equal(first.promptRef, started.promptRef);
  assert.equal(first.prompt, "Review content and grammar.");
  assert.equal(first.pagination.nextOffset, 4);
  const last = session.readRevision({
    monitorId: started.monitorId,
    revision: 0,
    offset: 4,
    maxCharacters: 20,
  });
  assert.equal(last.content, "456789");
  assert.equal(last.pagination.hasMore, false);

  const reused = await session.startMonitor({ path: target, pollIntervalMs: 30 });
  assert.equal(reused.monitorId, started.monitorId);
  assert.equal(reused.reused, true);
  assert.equal(reused.pollIntervalMs, 30);
  await assert.rejects(
    session.startMonitor({ path: target, prompt: "Use a different focus." }),
    (error) => error.code === "MONITOR_PROMPT_CONFLICT",
  );
});

test("uses the 250ms default poll and immediately probes after registering a waiter", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "before", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target });
  assert.equal(started.pollIntervalMs, 250);
  assert.equal(started.reviewLeaseMs, DEFAULT_REVIEW_LEASE_MS);

  await writeFile(target, "after", "utf8");
  const savedAt = Date.now();
  const saved = await waitForSaved(session, started.monitorId, 0);
  assert.equal(saved.event.revision, 1);
  assert.ok(Date.now() - savedAt < 500, "save detection exceeded the fast-path bound");

  const reused = await session.startMonitor({ path: target });
  assert.equal(reused.pollIntervalMs, 250);
  const slowed = await session.startMonitor({ path: target, pollIntervalMs: 60_000 });
  assert.equal(slowed.pollIntervalMs, 60_000);
  const reusedWithoutOverride = await session.startMonitor({ path: target });
  assert.equal(reusedWithoutOverride.pollIntervalMs, 60_000);

  await writeFile(target, "after again", "utf8");
  const immediateAt = Date.now();
  const immediatelyDetected = await waitForSaved(session, started.monitorId, 1);
  assert.equal(immediatelyDetected.event.revision, 2);
  assert.ok(
    Date.now() - immediateAt < 500,
    "waiter registration did not trigger an immediate probe",
  );
});

test("reviews and publishes directly with a revision-bound idempotent lease", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "baseline content", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({
    path: target,
    prompt: "Check meaning and grammar.",
    pollIntervalMs: 25,
  });

  const context = session.readReviewContext({ monitorId: started.monitorId });
  assert.equal(context.state, "review-ready");
  assert.equal(context.revision, 0);
  assert.equal(context.contentHash, started.contentHash);
  assert.equal(context.prompt, "Check meaning and grammar.");
  assert.equal(context.sourceArtifactId, started.revisionArtifactId);
  assert.equal(context.sourceKind, "revision");
  assert.equal(context.rebaselineRequired, false);
  assert.equal(context.documentContext.content, "baseline content");
  assert.equal(context.recentPublishedFeedback.length, 0);
  assert.equal(session.getStatus({ monitorId: started.monitorId }).reviewLease.active, true);

  const repeatedContext = session.readReviewContext({
    monitorId: started.monitorId,
    revision: 0,
  });
  assert.equal(repeatedContext.reviewToken, context.reviewToken);
  assert.equal(repeatedContext.leaseExpiresAt, context.leaseExpiresAt);
  assert.equal(repeatedContext.reused, true);

  assert.throws(() => session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: "review-foreign",
    revision: 0,
    contentHash: started.contentHash,
    feedback: "foreign",
  }), { code: "REVIEW_TOKEN_INVALID" });
  assert.equal(session.getStatus({ monitorId: started.monitorId }).publishedRevision, -1);

  const published = session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: context.reviewToken,
    revision: 0,
    contentHash: started.contentHash,
    feedback: "Baseline feedback",
  });
  assert.equal(published.state, "published");
  assert.equal(published.fieldArtifactId, null);
  assert.equal(published.feedback, "Baseline feedback");
  assert.equal(published.publishedRevision, 0);
  assert.equal(published.reused, false);
  assert.equal(session.getStatus({ monitorId: started.monitorId }).reviewLease.active, false);

  const retried = session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: context.reviewToken,
    revision: 0,
    contentHash: started.contentHash,
    feedback: "Baseline feedback",
  });
  assert.equal(retried.feedbackArtifactId, published.feedbackArtifactId);
  assert.equal(retried.reused, true);
  assert.throws(() => session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: context.reviewToken,
    revision: 0,
    contentHash: started.contentHash,
    feedback: "Different feedback",
  }), { code: "FEEDBACK_PUBLISH_CONFLICT" });
});

test("suspends idle lifecycle during analysis and restarts it after publish", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const session = new MonitorSession({
    idleWarningMs: 70,
    idleStopMs: 130,
    reviewLeaseMs: 400,
  });
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  const context = session.readReviewContext({ monitorId: started.monitorId });

  await delay(160);
  const duringAnalysis = session.getStatus({ monitorId: started.monitorId });
  assert.equal(duringAnalysis.status, "active");
  assert.equal(duringAnalysis.purged, false);
  assert.equal(duringAnalysis.reviewLease.active, true);
  assert.equal(duringAnalysis.idleSuspended, true);
  const diagnostic = await session.waitForSave({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 20,
  });
  assert.equal(diagnostic.state, "timeout");

  const publishedAt = Date.now();
  session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: context.reviewToken,
    revision: 0,
    contentHash: context.contentHash,
    feedback: "Finished after a long analysis",
  });
  const warning = await withDeadline(
    session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 }),
  );
  assert.equal(warning.state, "idle-warning");
  assert.ok(Date.now() - publishedAt >= 50, "idle clock did not restart at publish time");
  const stopped = await withDeadline(
    session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 }),
  );
  assert.equal(stopped.state, "idle-stopped");
  assert.equal(stopped.purged, true);
});

test("expires an abandoned review lease before restarting idle time", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const session = new MonitorSession({
    idleWarningMs: 70,
    idleStopMs: 130,
    reviewLeaseMs: 60,
  });
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  const context = session.readReviewContext({ monitorId: started.monitorId });

  await delay(85);
  const expired = session.getStatus({ monitorId: started.monitorId });
  assert.equal(expired.status, "active");
  assert.equal(expired.reviewLease.active, false);
  assert.equal(expired.idleSuspended, false);
  assert.ok(expired.idleForMs < 60, "idle clock did not restart when the lease expired");
  assert.throws(() => session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: context.reviewToken,
    revision: 0,
    contentHash: context.contentHash,
    feedback: "too late",
  }), { code: "REVIEW_TOKEN_INVALID" });

  const warning = await withDeadline(
    session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 }),
  );
  assert.equal(warning.state, "idle-warning");
});

test("makes an old review lease stale when a newer save is observed", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "zero", "utf8");
  const session = new MonitorSession({ reviewLeaseMs: 500 });
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  const baseline = session.readReviewContext({ monitorId: started.monitorId });
  session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: baseline.reviewToken,
    revision: 0,
    contentHash: baseline.contentHash,
    feedback: "baseline feedback",
  });
  const oldLease = session.readReviewContext({ monitorId: started.monitorId, revision: 0 });

  await writeFile(target, "one", "utf8");
  const saved = await waitForSaved(session, started.monitorId, 0);
  assert.equal(session.getStatus({ monitorId: started.monitorId }).reviewLease.active, false);
  assert.throws(() => session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: oldLease.reviewToken,
    revision: 0,
    contentHash: oldLease.contentHash,
    feedback: "obsolete feedback",
  }), { code: "STALE_REVISION" });

  const latest = session.readReviewContext({
    monitorId: started.monitorId,
    revision: saved.event.revision,
  });
  assert.equal(latest.sourceKind, "diff");
  assert.equal(latest.sourceArtifactId, saved.event.diffArtifactId);
  assert.equal(latest.rebaselineRequired, false);
  assert.deepEqual(
    latest.recentPublishedFeedback.map(({ revision, feedback }) => ({ revision, feedback })),
    [{ revision: 0, feedback: "baseline feedback" }],
  );
  const published = session.publishFeedback({
    monitorId: started.monitorId,
    reviewToken: latest.reviewToken,
    revision: latest.revision,
    contentHash: latest.contentHash,
    feedback: "revision one feedback",
  });
  assert.equal(published.publishedRevision, 1);
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

test("detects same-size saves and exposes an immediate refs-only diff artifact", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "cat", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });

  await writeFile(target, "dog", "utf8");
  const saved = await waitForSaved(session, started.monitorId, 0);
  assert.equal(saved.event.revision, 1);
  assert.equal(saved.event.saveSequence, 1);
  assert.equal(saved.event.metadata.sizeBytes, 3);
  assert.equal(saved.event.diffArtifactId, `diff-${started.monitorId}-0-1`);
  assert.equal("content" in saved.event, false);

  const diff = session.readDiffArtifact({
    monitorId: started.monitorId,
    diffArtifactId: saved.event.diffArtifactId,
  });
  assert.match(diff.content, /-cat/);
  assert.match(diff.content, /\+dog/);
  assert.equal(diff.fromRevision, 0);
  assert.equal(diff.revision, 1);
  assert.equal("lines" in diff.delta.hunks[0], false);
});

test("treats whitespace-only saves as grammar-relevant content revisions", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "alpha beta\ngamma", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });

  await writeFile(target, "alpha  beta\n\ngamma", "utf8");
  const saved = await waitForSaved(session, started.monitorId, 0);
  assert.equal(saved.event.revision, 1);
  assert.notEqual(saved.event.contentHash, started.contentHash);
  assert.equal(
    session.readRevision({ monitorId: started.monitorId, revision: 1 }).content,
    "alpha  beta\n\ngamma",
  );
});

test("same-content saves increment saveSequence without revision, wake-up, or idle reset", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "unchanged", "utf8");
  const session = new MonitorSession({ idleWarningMs: 110, idleStopMs: 190 });
  sessions.push(session);
  const startedAt = Date.now();
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });

  await delay(50);
  await writeFile(target, "unchanged", "utf8");
  await waitUntil(
    () => session.getStatus({ monitorId: started.monitorId }).saveSequence === 1,
  );
  const noRevision = await session.waitForSave({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 20,
  });
  assert.equal(noRevision.state, "timeout");
  assert.equal(noRevision.revision, 0);
  const warning = await withDeadline(
    session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 }),
  );
  assert.equal(warning.state, "idle-warning");
  assert.ok(Date.now() - startedAt < 165, "same-content save unexpectedly reset idle time");
});

test("processes sequential saves without throttling and preserves aggregate diffs", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "zero", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });

  const savedAt = Date.now();
  await writeFile(target, "one", "utf8");
  const first = await waitForSaved(session, started.monitorId, 0);
  assert.ok(Date.now() - savedAt < 500, "save waited for a removed throttle window");
  assert.equal(first.event.revision, 1);
  await writeFile(target, "two", "utf8");
  const second = await waitForSaved(session, started.monitorId, 1);
  assert.equal(second.event.revision, 2);
  assert.equal(second.event.diffArtifactId, `diff-${started.monitorId}-1-2`);

  const aggregate = await session.waitForSave({
    monitorId: started.monitorId,
    afterRevision: 0,
    timeoutMs: 0,
  });
  assert.equal(aggregate.state, "saved");
  assert.equal(aggregate.event.revision, 2);
  assert.equal(aggregate.event.diffArtifactId, `diff-${started.monitorId}-0-2`);
  const aggregateDiff = session.readDiffArtifact({
    monitorId: started.monitorId,
    diffArtifactId: aggregate.event.diffArtifactId,
  });
  assert.match(aggregateDiff.content, /-zero/);
  assert.match(aggregateDiff.content, /\+two/);
});

test("isolates artifacts per monitor and CAS-rejects stale or mismatched analysis", async () => {
  const directory = await temporaryDirectory();
  const firstTarget = path.join(directory, "first.md");
  const secondTarget = path.join(directory, "second.md");
  await writeFile(firstTarget, "first", "utf8");
  await writeFile(secondTarget, "second", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const first = await session.startMonitor({ path: firstTarget, pollIntervalMs: 25 });
  const second = await session.startMonitor({ path: secondTarget, pollIntervalMs: 25 });

  await writeFile(firstTarget, "FIRST", "utf8");
  const saved = await waitForSaved(session, first.monitorId, 0);
  assert.throws(
    () => session.readDiffArtifact({
      monitorId: second.monitorId,
      diffArtifactId: saved.event.diffArtifactId,
    }),
    { code: "ARTIFACT_NOT_FOUND" },
  );
  assert.throws(
    () => session.storeFieldAnalysis({
      monitorId: first.monitorId,
      revision: 1,
      contentHash: first.contentHash,
      sourceArtifactId: saved.event.diffArtifactId,
      field: "test",
      analysis: "stale",
    }),
    { code: "STALE_REVISION" },
  );
  assert.throws(
    () => session.storeFieldAnalysis({
      monitorId: first.monitorId,
      revision: 1,
      contentHash: saved.event.contentHash,
      sourceArtifactId: first.revisionArtifactId,
      field: "test",
      analysis: "wrong source revision",
    }),
    { code: "ARTIFACT_REVISION_MISMATCH" },
  );
});

test("versions field and feedback artifacts and supplies published review context", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "baseline", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({
    path: target,
    prompt: "Review both meaning and Korean grammar.",
    pollIntervalMs: 25,
  });

  const baselineField = session.storeFieldAnalysis({
    monitorId: started.monitorId,
    revision: 0,
    contentHash: started.contentHash,
    sourceArtifactId: started.revisionArtifactId,
    field: "software architecture",
    analysis: "Baseline field analysis",
  });
  assert.equal(session.readFieldAnalysis({
    monitorId: started.monitorId,
    fieldArtifactId: baselineField.fieldArtifactId,
  }).analysis, "Baseline field analysis");
  const baselineDraft = session.storeFeedbackDraft({
    monitorId: started.monitorId,
    revision: 0,
    contentHash: started.contentHash,
    sourceArtifactId: started.revisionArtifactId,
    fieldArtifactId: baselineField.fieldArtifactId,
    feedback: "Baseline feedback",
  });
  const published = session.markFeedbackPublished({
    monitorId: started.monitorId,
    feedbackArtifactId: baselineDraft.feedbackArtifactId,
    revision: 0,
    contentHash: started.contentHash,
    expectedPublishedRevision: -1,
  });
  assert.equal(published.publishedRevision, 0);
  assert.equal(session.markFeedbackPublished({
    monitorId: started.monitorId,
    feedbackArtifactId: baselineDraft.feedbackArtifactId,
    revision: 0,
    contentHash: started.contentHash,
    expectedPublishedRevision: -1,
  }).reused, true);

  await writeFile(target, "next revision", "utf8");
  const saved = await waitForSaved(session, started.monitorId, 0);
  const field = session.storeFieldAnalysis({
    monitorId: started.monitorId,
    revision: 1,
    contentHash: saved.event.contentHash,
    sourceArtifactId: saved.event.diffArtifactId,
    field: "software architecture",
    analysis: "The excerpt changes the architecture statement.",
  });
  const bundle = session.readReviewBundle({
    monitorId: started.monitorId,
    revision: 1,
    contentHash: saved.event.contentHash,
    sourceArtifactId: saved.event.diffArtifactId,
    fieldArtifactId: field.fieldArtifactId,
  });
  assert.equal(bundle.prompt, "Review both meaning and Korean grammar.");
  assert.match(bundle.excerpt.content, /\+next revision/);
  assert.equal(bundle.fieldAnalysis.analysis, field.analysis);
  assert.deepEqual(
    bundle.recentPublishedFeedback.map(({ revision, feedback }) => ({ revision, feedback })),
    [{ revision: 0, feedback: "Baseline feedback" }],
  );

  const draft = session.storeFeedbackDraft({
    monitorId: started.monitorId,
    revision: 1,
    contentHash: saved.event.contentHash,
    sourceArtifactId: saved.event.diffArtifactId,
    fieldArtifactId: field.fieldArtifactId,
    feedback: "Revision one feedback",
  });
  assert.equal(session.readFeedbackArtifact({
    monitorId: started.monitorId,
    feedbackArtifactId: draft.feedbackArtifactId,
  }).feedback, "Revision one feedback");
  assert.throws(() => session.markFeedbackPublished({
    monitorId: started.monitorId,
    feedbackArtifactId: draft.feedbackArtifactId,
    revision: 1,
    contentHash: saved.event.contentHash,
    expectedPublishedRevision: -1,
  }), { code: "PUBLISHED_REVISION_CONFLICT" });
  assert.equal(session.markFeedbackPublished({
    monitorId: started.monitorId,
    feedbackArtifactId: draft.feedbackArtifactId,
    revision: 1,
    contentHash: saved.event.contentHash,
    expectedPublishedRevision: 0,
  }).publishedRevision, 1);
});

test("rejects publishing a draft after a newer saved revision", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "zero", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  await writeFile(target, "one", "utf8");
  const first = await waitForSaved(session, started.monitorId, 0);
  const field = session.storeFieldAnalysis({
    monitorId: started.monitorId,
    revision: 1,
    contentHash: first.event.contentHash,
    sourceArtifactId: first.event.diffArtifactId,
    field: "general",
    analysis: "field result",
  });
  const draft = session.storeFeedbackDraft({
    monitorId: started.monitorId,
    revision: 1,
    contentHash: first.event.contentHash,
    sourceArtifactId: first.event.diffArtifactId,
    fieldArtifactId: field.fieldArtifactId,
    feedback: "draft",
  });
  await writeFile(target, "two", "utf8");
  await waitForSaved(session, started.monitorId, 1);
  assert.throws(() => session.markFeedbackPublished({
    monitorId: started.monitorId,
    feedbackArtifactId: draft.feedbackArtifactId,
    revision: 1,
    contentHash: first.event.contentHash,
    expectedPublishedRevision: -1,
  }), { code: "STALE_REVISION" });
});

test("survives one missing probe and classifies recreation as a replacement save", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "before", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 80 });
  await unlink(target);
  await waitUntil(
    () => session.getStatus({ monitorId: started.monitorId }).missingProbeCount === 1,
    500,
  );
  await writeFile(target, "after", "utf8");
  const saved = await waitForSaved(session, started.monitorId, 0, 1_000);
  assert.equal(saved.event.type, "replaced");
  assert.equal(saved.event.revision, 1);
  assert.equal(session.getStatus({ monitorId: started.monitorId }).status, "active");
});

test("confirms deletion after two missing probes and purges session artifacts", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "temporary", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  const waiting = session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 });
  await unlink(target);
  const deleted = await withDeadline(waiting);
  assert.equal(deleted.state, "deleted");
  assert.equal(deleted.reason, "target-deleted");
  assert.equal(deleted.purged, true);
  assert.equal(deleted.revisionArtifactId, null);
  assert.throws(() => session.readRevision({ monitorId: started.monitorId, revision: 0 }), {
    code: "REVISION_NOT_AVAILABLE",
  });
});

test("keeps idle warning/stop and resets idle only for changed content", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "before", "utf8");
  const session = new MonitorSession({ idleWarningMs: 70, idleStopMs: 130 });
  sessions.push(session);
  const started = await session.startMonitor({ path: target, pollIntervalMs: 25 });
  const warning = await withDeadline(
    session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 }),
  );
  assert.equal(warning.state, "idle-warning");
  assert.equal(warning.message, IDLE_WARNING_MESSAGE);

  await writeFile(target, "after", "utf8");
  const saved = await waitForSaved(session, started.monitorId, 0);
  const secondWarning = await session.waitForSave({
    monitorId: started.monitorId,
    afterRevision: saved.event.revision,
    timeoutMs: 500,
  });
  assert.equal(secondWarning.state, "idle-warning");
  const stopped = await withDeadline(session.waitForSave({
    monitorId: started.monitorId,
    afterRevision: saved.event.revision,
  }));
  assert.equal(stopped.state, "idle-stopped");
  assert.equal(stopped.purged, true);
});

test("explicit stop resolves waits and purges prompt, revisions, and artifacts", async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, "document.md");
  await writeFile(target, "content", "utf8");
  const session = new MonitorSession();
  sessions.push(session);
  const started = await session.startMonitor({
    path: target,
    prompt: "sensitive session prompt",
    pollIntervalMs: 25,
  });
  const pending = session.waitForSave({ monitorId: started.monitorId, afterRevision: 0 });
  const stoppedStatus = session.stopMonitor({ monitorId: started.monitorId });
  const stoppedWait = await pending;
  assert.equal(stoppedStatus.status, "stopped");
  assert.equal(stoppedStatus.purged, true);
  assert.equal(stoppedStatus.promptPresent, false);
  assert.equal(stoppedWait.state, "stopped");
  assert.throws(() => session.readRevision({ monitorId: started.monitorId, revision: 0 }), {
    code: "REVISION_NOT_AVAILABLE",
  });
});
