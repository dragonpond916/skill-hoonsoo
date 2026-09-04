#!/usr/bin/env node

import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_WAIT_MS = 300_000;
export const DEFAULT_SNAPSHOT_CHARACTERS = 32_000;
export const MAX_SNAPSHOT_CHARACTERS = 65_536;
export const MAX_DELTA_CHARACTERS = 24_000;
export const DEFAULT_IDLE_WARNING_MS = 60_000;
export const DEFAULT_IDLE_STOP_MS = 90_000;
export const DEFAULT_REVIEW_LEASE_MS = 180_000;
export const IDLE_WARNING_MESSAGE =
  "1분간 작업이 감지되지 않았습니다. 30초 더 기다린 후 세르파 모드가 정지됩니다.\n" +
  "나중에 다시 시작하려면 $sherpa를 호출해주세요.";

const DEFAULT_POLL_INTERVAL_MS = 25;
const READ_RETRY_DELAY_MS = 25;
const DEFAULT_CONTEXT_LINES = 5;
const MAX_EVENT_HISTORY = 64;
const MAX_DIFF_ARTIFACTS = MAX_EVENT_HISTORY * 2;
const MAX_FINE_DIFF_LINES = 100_000;
const MAX_LCS_CELLS = 1_000_000;
const MAX_LCS_OPERATION_LINES = 10_000;
const MAX_DELTA_LINES = 200;
const MAX_DELTA_TEXT_CHARACTERS = 12_000;
const MAX_DELTA_LINE_CHARACTERS = 4_000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PROMPT_CHARACTERS = 8_000;
const MAX_FIELD_CHARACTERS = 500;
const MAX_ANALYSIS_CHARACTERS = 16_000;
const MAX_FEEDBACK_CHARACTERS = 24_000;
const MAX_REVIEW_HISTORY_ITEMS = 10;
const MAX_REVIEW_HISTORY_CHARACTERS = 24_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SERVER_NAME = "sherpa";
const SERVER_VERSION = "0.6.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL_DEFINITIONS = [
  {
    name: "start_monitor",
    description:
      "Start an in-memory, read-only monitor for one UTF-8 regular file and return its first reviewContext inline. The path must be absolute. This tool never writes to the target or workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path to the regular file." },
        prompt: {
          type: "string",
          maxLength: MAX_PROMPT_CHARACTERS,
          description: "Optional combined content-and-grammar review instruction.",
        },
        pollIntervalMs: { type: "integer", minimum: 25, maximum: 60_000, default: 25 },
        contextLines: { type: "integer", minimum: 0, maximum: 50, default: 5 },
      },
    },
    annotations: {
      title: "Start Sherpa monitor",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "read_review_context",
    description:
      "Recovery-only compatibility tool. Read the latest bounded review context and acquire or reuse its analysis lease when start_monitor or wait_for_save did not supply reviewContext.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["monitorId"],
      properties: {
        monitorId: { type: "string" },
        revision: {
          type: "integer",
          minimum: 0,
          description: "Optional current-revision CAS assertion. Omit to select the latest revision.",
        },
      },
    },
    annotations: {
      title: "Read Sherpa inline review context",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "publish_feedback",
    description:
      "CAS-validate one inline review lease, mark the visible review as published, and restart the user-idle clock. The feedback body is optional because the host may already have shown it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["monitorId", "reviewToken", "revision", "contentHash"],
      properties: {
        monitorId: { type: "string" },
        reviewToken: { type: "string" },
        revision: { type: "integer", minimum: 0 },
        contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        feedback: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: MAX_FEEDBACK_CHARACTERS },
            { type: "null" },
          ],
          description: "Optional legacy copy of the already visible feedback.",
        },
      },
    },
    annotations: {
      title: "Publish Sherpa inline feedback",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "wait_for_save",
    description:
      "Wait locally until a saved content revision, the 60-second idle warning, the 90-second idle stop, cancellation, or an optional timeout. A saved result includes reviewContext inline. Same-content saves do not wake this call or reset content-idle time.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["monitorId"],
      properties: {
        monitorId: { type: "string" },
        afterRevision: { type: "integer", minimum: 0, default: 0 },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WAIT_MS,
          description: "Optional diagnostic timeout. Omit during normal monitoring.",
        },
      },
    },
    annotations: {
      title: "Wait for Sherpa save",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_status",
    description: "Get read-only status metadata for one monitor, or for every monitor in this server session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { monitorId: { type: "string" } },
    },
    annotations: {
      title: "Get Sherpa status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "stop_monitor",
    description: "Stop a monitor and release its timers. The target file is not modified.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["monitorId"],
      properties: { monitorId: { type: "string" } },
    },
    annotations: {
      title: "Stop Sherpa monitor",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export class SherpaError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SherpaError";
    this.code = code;
    this.details = details;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertObject(value, label = "arguments") {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SherpaError("INVALID_ARGUMENT", `${label} must be an object.`);
  }
  return value;
}

function integerOption(value, name, fallback, minimum, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new SherpaError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return resolved;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SherpaError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
  }
  return value;
}

export function normalizeTargetPath(inputPath) {
  requireString(inputPath, "path");
  if (inputPath.includes("\0")) {
    throw new SherpaError("INVALID_PATH", "path must not contain a NUL byte.");
  }
  if (!path.isAbsolute(inputPath)) {
    throw new SherpaError("INVALID_PATH", "path must be absolute.");
  }
  return path.normalize(path.resolve(inputPath));
}

function internalMetadata(fileStat) {
  const mtimeNs = fileStat.mtimeNs ?? BigInt(Math.trunc(fileStat.mtimeMs * 1_000_000));
  const ctimeNs = fileStat.ctimeNs ?? BigInt(Math.trunc(fileStat.ctimeMs * 1_000_000));
  return {
    dev: fileStat.dev.toString(),
    ino: fileStat.ino.toString(),
    size: Number(fileStat.size),
    mtimeNs: mtimeNs.toString(),
    ctimeNs: ctimeNs.toString(),
  };
}

function metadataSignature(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function identitySignature(metadata) {
  return `${metadata.dev}:${metadata.ino}`;
}

function publicMetadata(metadata) {
  if (!metadata) return null;
  return {
    sizeBytes: metadata.size,
    modifiedTimeNanoseconds: metadata.mtimeNs,
    changedTimeNanoseconds: metadata.ctimeNs,
    device: metadata.dev,
    inode: metadata.ino,
  };
}

function translateFileError(error, targetPath) {
  if (error instanceof SherpaError) return error;
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return new SherpaError("TARGET_NOT_FOUND", `Target does not exist: ${targetPath}`);
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new SherpaError("TARGET_NOT_READABLE", `Target is not readable: ${targetPath}`);
  }
  return new SherpaError("TARGET_READ_FAILED", `Failed to read target: ${targetPath}`, {
    cause: error?.code ?? error?.message ?? String(error),
  });
}

async function probeMetadata(targetPath) {
  try {
    const fileStat = await stat(targetPath, { bigint: true });
    if (!fileStat.isFile()) {
      throw new SherpaError("TARGET_NOT_REGULAR_FILE", `Target must be a regular file: ${targetPath}`);
    }
    if (fileStat.size > BigInt(MAX_FILE_BYTES)) {
      throw new SherpaError(
        "TARGET_TOO_LARGE",
        `Target exceeds the ${MAX_FILE_BYTES}-byte limit: ${targetPath}`,
      );
    }
    return internalMetadata(fileStat);
  } catch (error) {
    throw translateFileError(error, targetPath);
  }
}

async function readOpenedFileBounded(fileHandle, targetPath) {
  const chunks = [];
  let totalBytes = 0;
  let position = 0;

  while (true) {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > MAX_FILE_BYTES) {
      throw new SherpaError(
        "TARGET_TOO_LARGE",
        `Target exceeds the ${MAX_FILE_BYTES}-byte limit: ${targetPath}`,
      );
    }
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  const bytes = Buffer.concat(chunks, totalBytes);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new SherpaError("TARGET_NOT_UTF8", `Target is not valid UTF-8: ${targetPath}`);
  }
}

async function readPathOnce(targetPath) {
  let fileHandle;
  try {
    fileHandle = await open(targetPath, "r");
    const beforeStat = await fileHandle.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw new SherpaError("TARGET_NOT_REGULAR_FILE", `Target must be a regular file: ${targetPath}`);
    }
    if (beforeStat.size > BigInt(MAX_FILE_BYTES)) {
      throw new SherpaError(
        "TARGET_TOO_LARGE",
        `Target exceeds the ${MAX_FILE_BYTES}-byte limit: ${targetPath}`,
      );
    }
    const before = internalMetadata(beforeStat);
    const text = await readOpenedFileBounded(fileHandle, targetPath);
    const after = internalMetadata(await fileHandle.stat({ bigint: true }));
    const pathMetadata = await probeMetadata(targetPath);
    if (
      metadataSignature(before) !== metadataSignature(after) ||
      metadataSignature(after) !== metadataSignature(pathMetadata)
    ) {
      throw new SherpaError("TARGET_CHANGED_DURING_READ", `Target changed while being read: ${targetPath}`);
    }
    return { text, metadata: after };
  } catch (error) {
    throw translateFileError(error, targetPath);
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function readStablePath(targetPath, retryDelayMs, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readPathOnce(targetPath);
    } catch (error) {
      lastError = error;
      if (error.code !== "TARGET_CHANGED_DURING_READ" || attempt === attempts - 1) throw error;
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

function countLines(text) {
  if (text.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export function computeContentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function operation(type, oldLine, newLine, text) {
  return { type, oldLine, newLine, text };
}

function lcsMiddleOperations(oldLines, newLines, oldOffset, newOffset) {
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const cells = rows * columns;
  if (cells > MAX_LCS_CELLS || oldLines.length + newLines.length > MAX_LCS_OPERATION_LINES) {
    return null;
  }

  const table = new Uint32Array(cells);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const current = oldIndex * columns + newIndex;
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[current] = table[(oldIndex + 1) * columns + newIndex + 1] + 1;
      } else {
        table[current] = Math.max(
          table[(oldIndex + 1) * columns + newIndex],
          table[oldIndex * columns + newIndex + 1],
        );
      }
    }
  }

  const operations = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push(
        operation("context", oldOffset + oldIndex + 1, newOffset + newIndex + 1, oldLines[oldIndex]),
      );
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[(oldIndex + 1) * columns + newIndex] >= table[oldIndex * columns + newIndex + 1]
    ) {
      operations.push(
        operation("delete", oldOffset + oldIndex + 1, newOffset + newIndex + 1, oldLines[oldIndex]),
      );
      oldIndex += 1;
    } else {
      operations.push(
        operation("add", oldOffset + oldIndex + 1, newOffset + newIndex + 1, newLines[newIndex]),
      );
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    operations.push(
      operation("delete", oldOffset + oldIndex + 1, newOffset + newIndex + 1, oldLines[oldIndex]),
    );
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    operations.push(
      operation("add", oldOffset + oldIndex + 1, newOffset + newIndex + 1, newLines[newIndex]),
    );
    newIndex += 1;
  }
  return operations;
}

function coarseReplacementHunk(
  oldLines,
  newLines,
  prefixLength,
  suffixLength,
  allOldLines,
  allNewLines,
  contextLines,
) {
  const lines = [];
  const leadingStart = Math.max(0, prefixLength - contextLines);
  for (let index = leadingStart; index < prefixLength; index += 1) {
    lines.push(operation("context", index + 1, index + 1, allOldLines[index]));
  }

  const previewLimit = Math.max(1, Math.floor((MAX_DELTA_LINES - contextLines * 2) / 2));
  for (let index = 0; index < Math.min(oldLines.length, previewLimit); index += 1) {
    lines.push(operation("delete", prefixLength + index + 1, prefixLength + 1, oldLines[index]));
  }
  for (let index = 0; index < Math.min(newLines.length, previewLimit); index += 1) {
    lines.push(
      operation("add", prefixLength + oldLines.length + 1, prefixLength + index + 1, newLines[index]),
    );
  }

  for (let index = 0; index < Math.min(suffixLength, contextLines); index += 1) {
    const oldIndex = allOldLines.length - suffixLength + index;
    const newIndex = allNewLines.length - suffixLength + index;
    lines.push(operation("context", oldIndex + 1, newIndex + 1, allOldLines[oldIndex]));
  }

  return {
    oldStart: leadingStart + 1,
    oldCount: prefixLength - leadingStart + oldLines.length + Math.min(suffixLength, contextLines),
    newStart: leadingStart + 1,
    newCount: prefixLength - leadingStart + newLines.length + Math.min(suffixLength, contextLines),
    lines,
  };
}

function makeHunks(operations, contextLines) {
  const changedIndexes = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].type !== "context") changedIndexes.push(index);
  }
  if (changedIndexes.length === 0) return [];

  const ranges = [];
  let first = changedIndexes[0];
  let last = first;
  for (let index = 1; index < changedIndexes.length; index += 1) {
    const next = changedIndexes[index];
    if (next - last - 1 <= contextLines * 2) {
      last = next;
    } else {
      ranges.push([Math.max(0, first - contextLines), Math.min(operations.length - 1, last + contextLines)]);
      first = next;
      last = next;
    }
  }
  ranges.push([Math.max(0, first - contextLines), Math.min(operations.length - 1, last + contextLines)]);

  return ranges.map(([start, end]) => {
    const lines = operations.slice(start, end + 1);
    const oldAffected = lines.filter((line) => line.type !== "add");
    const newAffected = lines.filter((line) => line.type !== "delete");
    return {
      oldStart: lines[0].oldLine,
      oldCount: oldAffected.length,
      newStart: lines[0].newLine,
      newCount: newAffected.length,
      lines,
    };
  });
}

function truncateDelta(delta) {
  let includedLines = 0;
  let includedTextCharacters = 0;
  let truncated = delta.truncated;
  const hunks = [];
  let exhausted = false;

  for (const hunk of delta.hunks) {
    const lines = [];
    for (const line of hunk.lines) {
      if (includedLines >= MAX_DELTA_LINES) {
        truncated = true;
        exhausted = true;
        break;
      }
      const remaining = MAX_DELTA_TEXT_CHARACTERS - includedTextCharacters;
      if (remaining <= 0) {
        truncated = true;
        exhausted = true;
        break;
      }
      let text = line.text;
      const lineLimit = Math.min(remaining, MAX_DELTA_LINE_CHARACTERS);
      if (text.length > lineLimit) {
        const headLength = Math.max(0, Math.floor((lineLimit - 1) / 2));
        const tailLength = Math.max(0, lineLimit - headLength - 1);
        text = `${text.slice(0, headLength)}…${text.slice(text.length - tailLength)}`;
        truncated = true;
      }
      lines.push({ ...line, text });
      includedLines += 1;
      includedTextCharacters += text.length;
    }
    if (lines.length > 0) hunks.push({ ...hunk, lines });
    if (exhausted) break;
  }

  const bounded = {
    ...delta,
    hunks,
    truncated,
    truncationReason: truncated ? delta.truncationReason ?? "delta-payload-limit" : null,
    includedLineOperations: includedLines,
  };

  while (JSON.stringify(bounded).length > MAX_DELTA_CHARACTERS && bounded.hunks.length > 0) {
    const lastHunk = bounded.hunks.at(-1);
    lastHunk.lines.pop();
    bounded.includedLineOperations -= 1;
    bounded.truncated = true;
    bounded.truncationReason = "delta-payload-limit";
    if (lastHunk.lines.length === 0) bounded.hunks.pop();
  }
  return bounded;
}

function extremelyLargeLineDelta(previousText, currentText, contextLines) {
  const oldLineCount = countLines(previousText);
  const newLineCount = countLines(currentText);
  const previewLimit = Math.min(MAX_DELTA_TEXT_CHARACTERS / 2, 4_000);
  const oldPreview = previousText.slice(0, previewLimit).split("\n").slice(0, contextLines + 1);
  const newPreview = currentText.slice(0, previewLimit).split("\n").slice(0, contextLines + 1);
  const lines = [
    ...oldPreview.map((text, index) => operation("delete", index + 1, 1, text)),
    ...newPreview.map((text, index) => operation("add", oldLineCount + 1, index + 1, text)),
  ];
  return truncateDelta({
    algorithm: "bounded-line-replacement",
    oldLineCount,
    newLineCount,
    additions: newLineCount,
    deletions: oldLineCount,
    contextLines,
    hunks: [
      {
        oldStart: 1,
        oldCount: oldLineCount,
        newStart: 1,
        newCount: newLineCount,
        lines,
      },
    ],
    truncated: true,
    truncationReason: "line-count-limit",
  });
}

export function computeLineDelta(previousText, currentText, contextLines = DEFAULT_CONTEXT_LINES) {
  if (previousText === currentText) {
    return {
      algorithm: "bounded-lcs-line",
      oldLineCount: countLines(previousText),
      newLineCount: countLines(currentText),
      additions: 0,
      deletions: 0,
      contextLines,
      hunks: [],
      truncated: false,
      truncationReason: null,
      includedLineOperations: 0,
    };
  }

  const oldLineCount = countLines(previousText);
  const newLineCount = countLines(currentText);
  if (oldLineCount > MAX_FINE_DIFF_LINES || newLineCount > MAX_FINE_DIFF_LINES) {
    return extremelyLargeLineDelta(previousText, currentText, contextLines);
  }

  const oldLines = previousText.length === 0 ? [] : previousText.split("\n");
  const newLines = currentText.length === 0 ? [] : currentText.split("\n");
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - suffixLength - 1] === newLines[newLines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const oldMiddle = oldLines.slice(prefixLength, oldLines.length - suffixLength);
  const newMiddle = newLines.slice(prefixLength, newLines.length - suffixLength);
  let middleOperations = lcsMiddleOperations(oldMiddle, newMiddle, prefixLength, prefixLength);
  const usedCoarseFallback = middleOperations === null;
  if (usedCoarseFallback) {
    return truncateDelta({
      algorithm: "bounded-line-replacement",
      oldLineCount: oldLines.length,
      newLineCount: newLines.length,
      additions: newMiddle.length,
      deletions: oldMiddle.length,
      contextLines,
      hunks: [
        coarseReplacementHunk(
          oldMiddle,
          newMiddle,
          prefixLength,
          suffixLength,
          oldLines,
          newLines,
          contextLines,
        ),
      ],
      truncated: true,
      truncationReason: "lcs-cell-limit",
    });
  }

  const operations = [];
  const leadingContextStart = Math.max(0, prefixLength - contextLines);
  for (let index = leadingContextStart; index < prefixLength; index += 1) {
    operations.push(operation("context", index + 1, index + 1, oldLines[index]));
  }
  for (const item of middleOperations) operations.push(item);
  for (let index = 0; index < Math.min(suffixLength, contextLines); index += 1) {
    const oldIndex = oldLines.length - suffixLength + index;
    const newIndex = newLines.length - suffixLength + index;
    operations.push(operation("context", oldIndex + 1, newIndex + 1, oldLines[oldIndex]));
  }

  const additions = middleOperations.filter((item) => item.type === "add").length;
  const deletions = middleOperations.filter((item) => item.type === "delete").length;
  return truncateDelta({
    algorithm: "bounded-lcs-line",
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    additions,
    deletions,
    contextLines,
    hunks: makeHunks(operations, contextLines),
    truncated: false,
    truncationReason: null,
  });
}

function changedRanges(delta) {
  return delta.hunks.map((hunk) => ({
    startLine: hunk.newStart,
    endLine: Math.max(hunk.newStart, hunk.newStart + Math.max(0, hunk.newCount - 1)),
  }));
}

function formatDiffExcerpt(delta) {
  const lines = [];
  for (const hunk of delta.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
      lines.push(`${prefix}${line.text}`);
    }
  }
  return lines.join("\n");
}

function deltaReference(delta) {
  return {
    algorithm: delta.algorithm,
    oldLineCount: delta.oldLineCount,
    newLineCount: delta.newLineCount,
    additions: delta.additions,
    deletions: delta.deletions,
    contextLines: delta.contextLines,
    truncated: delta.truncated,
    truncationReason: delta.truncationReason,
    includedLineOperations: delta.includedLineOperations,
    hunks: delta.hunks.map(({ oldStart, oldCount, newStart, newCount }) => ({
      oldStart,
      oldCount,
      newStart,
      newCount,
    })),
  };
}

function pageText(text, offset, maxCharacters) {
  if (offset > text.length) {
    throw new SherpaError(
      "INVALID_ARGUMENT",
      `offset ${offset} is beyond the snapshot length ${text.length}.`,
    );
  }
  let end = Math.min(text.length, offset + maxCharacters);
  if (end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  const content = text.slice(offset, end);
  return {
    content,
    pagination: {
      offset,
      returnedCharacters: content.length,
      totalCharacters: text.length,
      nextOffset: end < text.length ? end : null,
      hasMore: end < text.length,
    },
  };
}

export class MonitorSession {
  constructor(options = {}) {
    const args = assertObject(options, "MonitorSession options");
    this.idleWarningMs = integerOption(
      args.idleWarningMs,
      "idleWarningMs",
      DEFAULT_IDLE_WARNING_MS,
      1,
      24 * 60 * 60 * 1_000,
    );
    this.idleStopMs = integerOption(
      args.idleStopMs,
      "idleStopMs",
      DEFAULT_IDLE_STOP_MS,
      2,
      24 * 60 * 60 * 1_000,
    );
    if (this.idleStopMs <= this.idleWarningMs) {
      throw new SherpaError("INVALID_ARGUMENT", "idleStopMs must be greater than idleWarningMs.");
    }
    this.reviewLeaseMs = integerOption(
      args.reviewLeaseMs,
      "reviewLeaseMs",
      DEFAULT_REVIEW_LEASE_MS,
      1,
      24 * 60 * 60 * 1_000,
    );
    this.now = args.now ?? Date.now;
    if (typeof this.now !== "function") {
      throw new SherpaError("INVALID_ARGUMENT", "now must be a function.");
    }
    this.monitors = new Map();
    this.activeByPath = new Map();
    this.nextMonitorNumber = 1;
    this.closed = false;
  }

  async startMonitor(input) {
    const args = assertObject(input);
    const targetPath = normalizeTargetPath(args.path);
    const prompt = this.#boundedString(
      args.prompt ?? "",
      "prompt",
      MAX_PROMPT_CHARACTERS,
      true,
    );
    const activeId = this.activeByPath.get(targetPath);
    const active = activeId ? this.monitors.get(activeId) : undefined;
    if (active?.status === "active") {
      if (args.prompt !== undefined && prompt !== active.prompt) {
        throw new SherpaError(
          "MONITOR_PROMPT_CONFLICT",
          "An active monitor keeps one immutable invocation prompt. Stop it before starting the same target with a different prompt.",
        );
      }
      if (args.pollIntervalMs !== undefined) {
        active.pollIntervalMs = integerOption(
          args.pollIntervalMs,
          "pollIntervalMs",
          active.pollIntervalMs,
          25,
          60_000,
        );
        this.#restartPollTimer(active);
      }
      if (args.contextLines !== undefined) {
        active.contextLines = integerOption(
          args.contextLines,
          "contextLines",
          active.contextLines,
          0,
          50,
        );
      }
      const reviewContext =
        active.publishedRevision < active.revision
          ? this.#inlineReviewContext(active, active.revision)
          : null;
      return { ...this.#status(active), reused: true, reviewContext };
    }

    const pollIntervalMs = integerOption(
      args.pollIntervalMs,
      "pollIntervalMs",
      DEFAULT_POLL_INTERVAL_MS,
      25,
      60_000,
    );
    const contextLines = integerOption(
      args.contextLines,
      "contextLines",
      DEFAULT_CONTEXT_LINES,
      0,
      50,
    );

    const snapshot = await readStablePath(targetPath, READ_RETRY_DELAY_MS);
    const startedAtMs = this.now();
    const monitorId = "monitor-" + this.nextMonitorNumber++;
    const promptHash = computeContentHash(prompt);
    const monitor = {
      id: monitorId,
      path: targetPath,
      prompt,
      promptHash,
      promptRef: "prompt-" + monitorId + "-" + promptHash.slice(0, 16),
      status: "active",
      reason: null,
      error: null,
      purged: false,
      revision: 0,
      saveSequence: 0,
      publishedRevision: -1,
      observedSnapshot: snapshot,
      currentContentHash: computeContentHash(snapshot.text),
      revisionArtifacts: new Map(),
      revisionArtifactsById: new Map(),
      diffArtifacts: new Map(),
      diffArtifactsByRange: new Map(),
      fieldArtifacts: new Map(),
      fieldArtifactByRevision: new Map(),
      feedbackArtifacts: new Map(),
      feedbackArtifactByRevision: new Map(),
      publishedFeedbackIds: [],
      saveRecords: [],
      pollIntervalMs,
      contextLines,
      startedAt: new Date(startedAtMs).toISOString(),
      lastEventAt: null,
      lastSaveAt: null,
      lastContentActivityAtMs: startedAtMs,
      idleWarningIssued: false,
      idleWarningPending: false,
      idleWarningDelivered: false,
      events: [],
      waiters: new Set(),
      pollTimer: null,
      idleTimer: null,
      reviewLease: null,
      polling: false,
      missingProbes: 0,
    };
    this.#storeRevisionArtifact(monitor, 0, snapshot);
    this.monitors.set(monitor.id, monitor);
    this.activeByPath.set(targetPath, monitor.id);
    this.#restartPollTimer(monitor);
    this.#scheduleIdleTimer(monitor);
    const reviewContext = this.#inlineReviewContext(monitor, 0);
    return { ...this.#status(monitor), reused: false, reviewContext };
  }

  readRevision(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const revision = integerOption(
      args.revision,
      "revision",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const offset = integerOption(args.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const maxCharacters = integerOption(
      args.maxCharacters,
      "maxCharacters",
      DEFAULT_SNAPSHOT_CHARACTERS,
      1,
      MAX_SNAPSHOT_CHARACTERS,
    );
    const artifact = this.#requireRevisionArtifact(monitor, revision);
    return {
      monitorId: monitor.id,
      path: monitor.path,
      revision,
      revisionArtifactId: artifact.id,
      contentHash: artifact.contentHash,
      promptRef: monitor.promptRef,
      prompt: monitor.prompt,
      metadata: publicMetadata(artifact.snapshot.metadata),
      ...pageText(artifact.snapshot.text, offset, maxCharacters),
    };
  }

  readReviewContext(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const revision =
      args.revision === undefined
        ? monitor.revision
        : integerOption(
            args.revision,
            "revision",
            undefined,
            0,
            Number.MAX_SAFE_INTEGER,
          );
    if (revision !== monitor.revision) {
      throw new SherpaError(
        "STALE_REVISION",
        "The latest review target is revision " + monitor.revision + ".",
      );
    }
    const current = this.#assertCurrentRevision(
      monitor,
      revision,
      monitor.currentContentHash,
    );
    const { source, rebaselineRequired } = this.#selectReviewSource(
      monitor,
      revision,
      current,
    );
    const sourceArtifactId = source.artifact.id;
    const previousReviewToken = monitor.reviewLease?.token;
    const lease = this.#acquireReviewLease(
      monitor,
      revision,
      current.contentHash,
      sourceArtifactId,
    );
    const excerpt =
      source.kind === "diff"
        ? {
            content: source.artifact.excerpt,
            truncated: source.artifact.delta.truncated,
            changedRanges: source.artifact.changedRanges,
          }
        : {
            content: current.snapshot.text.slice(0, MAX_DELTA_TEXT_CHARACTERS),
            truncated: current.snapshot.text.length > MAX_DELTA_TEXT_CHARACTERS,
            changedRanges: [
              {
                startLine: 1,
                endLine: Math.max(1, countLines(current.snapshot.text)),
              },
            ],
          };
    const documentContent = current.snapshot.text.slice(
      0,
      DEFAULT_SNAPSHOT_CHARACTERS,
    );

    return {
      state: "review-ready",
      monitorId: monitor.id,
      reviewToken: lease.token,
      revision,
      contentHash: current.contentHash,
      prompt: monitor.prompt,
      sourceArtifactId,
      sourceKind: source.kind,
      excerpt,
      documentContext: {
        content: documentContent,
        truncated: documentContent.length < current.snapshot.text.length,
        totalCharacters: current.snapshot.text.length,
      },
      recentPublishedFeedback: this.#recentPublishedFeedback(monitor, revision, 3),
      publishedRevision: monitor.publishedRevision,
      rebaselineRequired,
      leaseExpiresAt: new Date(lease.expiresAtMs).toISOString(),
      reused: previousReviewToken === lease.token,
    };
  }

  #inlineReviewContext(monitor, revision) {
    const context = this.readReviewContext({ monitorId: monitor.id, revision });
    const input =
      context.sourceKind === "diff" && !context.rebaselineRequired
        ? {
            kind: "diff",
            content: context.excerpt.content,
            truncated: context.excerpt.truncated,
            changedRanges: context.excerpt.changedRanges,
          }
        : {
            kind: "document",
            content: context.documentContext.content,
            truncated: context.documentContext.truncated,
            totalCharacters: context.documentContext.totalCharacters,
          };
    return {
      state: context.state,
      monitorId: context.monitorId,
      reviewToken: context.reviewToken,
      revision: context.revision,
      contentHash: context.contentHash,
      prompt: context.prompt,
      sourceArtifactId: context.sourceArtifactId,
      sourceKind: context.sourceKind,
      input,
      publishedRevision: context.publishedRevision,
      rebaselineRequired: context.rebaselineRequired,
      leaseExpiresAt: context.leaseExpiresAt,
      reused: context.reused,
    };
  }

  publishFeedback(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const reviewToken = requireString(args.reviewToken, "reviewToken");
    const revision = integerOption(
      args.revision,
      "revision",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const contentHash = requireString(args.contentHash, "contentHash");
    const feedback =
      args.feedback === undefined || args.feedback === null
        ? null
        : this.#boundedString(
            args.feedback,
            "feedback",
            MAX_FEEDBACK_CHARACTERS,
          );

    this.#assertCurrentRevision(monitor, revision, contentHash);
    const completed = [...monitor.feedbackArtifacts.values()].find(
      (artifact) => artifact.reviewToken === reviewToken,
    );
    if (completed) {
      if (
        completed.revision === revision &&
        completed.contentHash === contentHash &&
        completed.feedback === feedback &&
        completed.state === "published"
      ) {
        return {
          state: "published",
          monitorId: monitor.id,
          reviewToken,
          ...this.#publicFeedbackArtifact(completed),
          publishedRevision: monitor.publishedRevision,
          reused: true,
        };
      }
      throw new SherpaError(
        "FEEDBACK_PUBLISH_CONFLICT",
        "The review token was already consumed by different feedback.",
      );
    }

    const lease = monitor.reviewLease;
    if (!lease || lease.token !== reviewToken) {
      throw new SherpaError(
        "REVIEW_TOKEN_INVALID",
        "The review token is not active for this monitor.",
      );
    }
    if (lease.expiresAtMs <= this.now()) {
      this.#expireReviewLease(monitor, reviewToken);
      throw new SherpaError("REVIEW_LEASE_EXPIRED", "The review lease has expired.");
    }
    if (
      lease.revision !== revision ||
      lease.contentHash !== contentHash
    ) {
      throw new SherpaError(
        "ARTIFACT_REVISION_MISMATCH",
        "The review lease does not match the requested revision and content hash.",
      );
    }
    this.#requireSourceArtifact(
      monitor,
      lease.sourceArtifactId,
      revision,
      contentHash,
    );
    if (monitor.publishedRevision !== lease.expectedPublishedRevision) {
      throw new SherpaError(
        "PUBLISHED_REVISION_CONFLICT",
        "Published feedback advanced after this review lease was acquired.",
      );
    }

    const existingId = monitor.feedbackArtifactByRevision.get(revision);
    if (existingId) {
      throw new SherpaError(
        "FEEDBACK_PUBLISH_CONFLICT",
        "Different feedback already exists for revision " + revision + ".",
      );
    }

    const publishedAtMs = this.now();
    const publishedAt = new Date(publishedAtMs).toISOString();
    const artifact = {
      id: "feedback-" + monitor.id + "-" + revision,
      revision,
      contentHash,
      sourceArtifactId: lease.sourceArtifactId,
      fieldArtifactId: null,
      reviewToken,
      feedback,
      state: "published",
      createdAt: publishedAt,
      publishedAt,
    };
    monitor.feedbackArtifacts.set(artifact.id, artifact);
    monitor.feedbackArtifactByRevision.set(revision, artifact.id);
    monitor.publishedRevision = revision;
    monitor.publishedFeedbackIds.push(artifact.id);
    this.#clearReviewLease(monitor);
    this.#restartIdleClock(monitor, publishedAtMs);

    return {
      state: "published",
      monitorId: monitor.id,
      reviewToken,
      ...this.#publicFeedbackArtifact(artifact),
      publishedRevision: monitor.publishedRevision,
      reused: false,
    };
  }

  waitForSave(input, signal = undefined) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const afterRevision = integerOption(
      args.afterRevision,
      "afterRevision",
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const timeoutMs =
      args.timeoutMs === undefined
        ? null
        : integerOption(args.timeoutMs, "timeoutMs", 0, 0, MAX_WAIT_MS);
    if (afterRevision > monitor.revision) {
      throw new SherpaError(
        "REVISION_AHEAD",
        "afterRevision " +
          afterRevision +
          " is ahead of current revision " +
          monitor.revision +
          ".",
      );
    }
    if (monitor.status === "active" && monitor.revision > afterRevision) {
      return Promise.resolve(this.#saveResult(monitor, afterRevision));
    }
    if (monitor.status === "error") {
      return Promise.resolve({ state: "error", ...this.#status(monitor) });
    }
    if (monitor.status !== "active") {
      return Promise.resolve({
        state:
          monitor.reason === "idle-timeout"
            ? "idle-stopped"
            : monitor.reason === "target-deleted"
              ? "deleted"
              : "stopped",
        ...this.#status(monitor),
      });
    }
    if (monitor.idleWarningPending && !monitor.idleWarningDelivered) {
      monitor.idleWarningPending = false;
      monitor.idleWarningDelivered = true;
      return Promise.resolve(this.#idleWarningResult(monitor));
    }
    if (timeoutMs === 0) {
      return Promise.resolve({
        state: "timeout",
        monitorId: monitor.id,
        revision: monitor.revision,
        saveSequence: monitor.saveSequence,
        status: monitor.status,
      });
    }

    return new Promise((resolve) => {
      const waiter = {
        afterRevision,
        resolve: (result) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          signal?.removeEventListener("abort", waiter.abort);
          monitor.waiters.delete(waiter);
          resolve(result);
        },
        abort: () => {
          waiter.resolve({
            state: "cancelled",
            monitorId: monitor.id,
            revision: monitor.revision,
            saveSequence: monitor.saveSequence,
            status: monitor.status,
          });
        },
        timer: null,
      };
      if (timeoutMs !== null) {
        waiter.timer = setTimeout(() => {
          waiter.resolve({
            state: "timeout",
            monitorId: monitor.id,
            revision: monitor.revision,
            saveSequence: monitor.saveSequence,
            status: monitor.status,
          });
        }, timeoutMs);
      }
      monitor.waiters.add(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
      else void this.#poll(monitor);
    });
  }

  readDiffArtifact(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const diffArtifactId = requireString(args.diffArtifactId, "diffArtifactId");
    const offset = integerOption(args.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const maxCharacters = integerOption(
      args.maxCharacters,
      "maxCharacters",
      DEFAULT_SNAPSHOT_CHARACTERS,
      1,
      MAX_SNAPSHOT_CHARACTERS,
    );
    const artifact = this.#requireDiffArtifact(monitor, diffArtifactId);
    return {
      monitorId: monitor.id,
      diffArtifactId: artifact.id,
      fromRevision: artifact.fromRevision,
      revision: artifact.revision,
      fromContentHash: artifact.fromContentHash,
      contentHash: artifact.contentHash,
      promptRef: monitor.promptRef,
      prompt: monitor.prompt,
      changedRanges: artifact.changedRanges,
      delta: artifact.delta,
      ...pageText(artifact.excerpt, offset, maxCharacters),
    };
  }

  storeFieldAnalysis(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const revision = integerOption(
      args.revision,
      "revision",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const contentHash = requireString(args.contentHash, "contentHash");
    const sourceArtifactId = requireString(args.sourceArtifactId, "sourceArtifactId");
    const field = this.#boundedString(args.field, "field", MAX_FIELD_CHARACTERS);
    const analysis = this.#boundedString(
      args.analysis,
      "analysis",
      MAX_ANALYSIS_CHARACTERS,
    );
    this.#assertCurrentRevision(monitor, revision, contentHash);
    this.#requireSourceArtifact(monitor, sourceArtifactId, revision, contentHash);

    const existingId = monitor.fieldArtifactByRevision.get(revision);
    if (existingId) {
      const existing = monitor.fieldArtifacts.get(existingId);
      if (
        existing.contentHash === contentHash &&
        existing.sourceArtifactId === sourceArtifactId &&
        existing.field === field &&
        existing.analysis === analysis
      ) {
        return { ...this.#publicFieldArtifact(existing), reused: true };
      }
      throw new SherpaError(
        "FIELD_ANALYSIS_CONFLICT",
        "A different FieldChecker artifact already exists for revision " + revision + ".",
      );
    }

    const artifact = {
      id: "field-" + monitor.id + "-" + revision,
      revision,
      contentHash,
      sourceArtifactId,
      field,
      analysis,
      createdAt: new Date(this.now()).toISOString(),
    };
    monitor.fieldArtifacts.set(artifact.id, artifact);
    monitor.fieldArtifactByRevision.set(revision, artifact.id);
    return { ...this.#publicFieldArtifact(artifact), reused: false };
  }

  readFieldAnalysis(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const artifact = this.#requireFieldArtifact(
      monitor,
      requireString(args.fieldArtifactId, "fieldArtifactId"),
    );
    return this.#publicFieldArtifact(artifact);
  }

  readReviewBundle(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const revision = integerOption(
      args.revision,
      "revision",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const contentHash = requireString(args.contentHash, "contentHash");
    const sourceArtifactId = requireString(args.sourceArtifactId, "sourceArtifactId");
    const fieldArtifactId = requireString(args.fieldArtifactId, "fieldArtifactId");
    const feedbackLimit = integerOption(
      args.feedbackLimit,
      "feedbackLimit",
      3,
      0,
      MAX_REVIEW_HISTORY_ITEMS,
    );
    this.#assertCurrentRevision(monitor, revision, contentHash);
    const source = this.#requireSourceArtifact(
      monitor,
      sourceArtifactId,
      revision,
      contentHash,
    );
    const fieldArtifact = this.#requireFieldArtifact(monitor, fieldArtifactId);
    this.#assertFieldMatches(
      fieldArtifact,
      revision,
      contentHash,
      sourceArtifactId,
    );

    const excerpt =
      source.kind === "diff"
        ? {
            content: source.artifact.excerpt,
            truncated: source.artifact.delta.truncated,
            changedRanges: source.artifact.changedRanges,
          }
        : {
            content: source.artifact.snapshot.text.slice(0, MAX_DELTA_TEXT_CHARACTERS),
            truncated: source.artifact.snapshot.text.length > MAX_DELTA_TEXT_CHARACTERS,
            changedRanges: [
              {
                startLine: 1,
                endLine: Math.max(1, countLines(source.artifact.snapshot.text)),
              },
            ],
          };

    const recentPublishedFeedback = this.#recentPublishedFeedback(
      monitor,
      revision,
      feedbackLimit,
    );

    return {
      monitorId: monitor.id,
      revision,
      contentHash,
      promptRef: monitor.promptRef,
      prompt: monitor.prompt,
      sourceArtifactId,
      sourceKind: source.kind,
      excerpt,
      fieldAnalysis: this.#publicFieldArtifact(fieldArtifact),
      recentPublishedFeedback,
      publishedRevision: monitor.publishedRevision,
    };
  }

  storeFeedbackDraft(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const revision = integerOption(
      args.revision,
      "revision",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const contentHash = requireString(args.contentHash, "contentHash");
    const sourceArtifactId = requireString(args.sourceArtifactId, "sourceArtifactId");
    const fieldArtifactId = requireString(args.fieldArtifactId, "fieldArtifactId");
    const feedback = this.#boundedString(
      args.feedback,
      "feedback",
      MAX_FEEDBACK_CHARACTERS,
    );
    this.#assertCurrentRevision(monitor, revision, contentHash);
    this.#requireSourceArtifact(monitor, sourceArtifactId, revision, contentHash);
    const fieldArtifact = this.#requireFieldArtifact(monitor, fieldArtifactId);
    this.#assertFieldMatches(
      fieldArtifact,
      revision,
      contentHash,
      sourceArtifactId,
    );

    const existingId = monitor.feedbackArtifactByRevision.get(revision);
    if (existingId) {
      const existing = monitor.feedbackArtifacts.get(existingId);
      if (
        existing.contentHash === contentHash &&
        existing.sourceArtifactId === sourceArtifactId &&
        existing.fieldArtifactId === fieldArtifactId &&
        existing.feedback === feedback
      ) {
        return { ...this.#publicFeedbackArtifact(existing), reused: true };
      }
      throw new SherpaError(
        "FEEDBACK_DRAFT_CONFLICT",
        "A different feedback artifact already exists for revision " + revision + ".",
      );
    }

    const artifact = {
      id: "feedback-" + monitor.id + "-" + revision,
      revision,
      contentHash,
      sourceArtifactId,
      fieldArtifactId,
      feedback,
      state: "draft",
      createdAt: new Date(this.now()).toISOString(),
      publishedAt: null,
    };
    monitor.feedbackArtifacts.set(artifact.id, artifact);
    monitor.feedbackArtifactByRevision.set(revision, artifact.id);
    return { ...this.#publicFeedbackArtifact(artifact), reused: false };
  }

  readFeedbackArtifact(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const artifact = this.#requireFeedbackArtifact(
      monitor,
      requireString(args.feedbackArtifactId, "feedbackArtifactId"),
    );
    return this.#publicFeedbackArtifact(artifact);
  }

  markFeedbackPublished(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const feedbackArtifactId = requireString(
      args.feedbackArtifactId,
      "feedbackArtifactId",
    );
    const revision = integerOption(
      args.revision,
      "revision",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const contentHash = requireString(args.contentHash, "contentHash");
    const expectedPublishedRevision = integerOption(
      args.expectedPublishedRevision,
      "expectedPublishedRevision",
      undefined,
      -1,
      Number.MAX_SAFE_INTEGER,
    );
    this.#assertCurrentRevision(monitor, revision, contentHash);
    const artifact = this.#requireFeedbackArtifact(monitor, feedbackArtifactId);
    if (artifact.revision !== revision || artifact.contentHash !== contentHash) {
      throw new SherpaError(
        "ARTIFACT_REVISION_MISMATCH",
        "Feedback artifact does not match the requested revision and content hash.",
      );
    }
    if (artifact.state === "published") {
      return {
        ...this.#publicFeedbackArtifact(artifact),
        publishedRevision: monitor.publishedRevision,
        reused: true,
      };
    }
    if (monitor.publishedRevision !== expectedPublishedRevision) {
      throw new SherpaError(
        "PUBLISHED_REVISION_CONFLICT",
        "Expected publishedRevision " +
          expectedPublishedRevision +
          " but found " +
          monitor.publishedRevision +
          ".",
      );
    }

    artifact.state = "published";
    artifact.publishedAt = new Date(this.now()).toISOString();
    monitor.publishedRevision = revision;
    monitor.publishedFeedbackIds.push(artifact.id);
    return {
      ...this.#publicFeedbackArtifact(artifact),
      publishedRevision: monitor.publishedRevision,
      reused: false,
    };
  }

  getStatus(input = {}) {
    const args = assertObject(input);
    if (args.monitorId !== undefined) return this.#status(this.#requireMonitor(args.monitorId));
    return { monitors: [...this.monitors.values()].map((monitor) => this.#status(monitor)) };
  }

  stopMonitor(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    if (monitor.status === "active") this.#stop(monitor, "user-stopped", "stopped");
    return this.#status(monitor);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const monitor of this.monitors.values()) {
      if (monitor.status === "active") this.#stop(monitor, "session-ended", "stopped");
      else this.#purge(monitor);
    }
    this.activeByPath.clear();
  }

  #boundedString(value, name, maximum, allowEmpty = false) {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
      throw new SherpaError(
        "INVALID_ARGUMENT",
        name + " must be " + (allowEmpty ? "a string" : "a non-empty string") + ".",
      );
    }
    if (value.length > maximum) {
      throw new SherpaError(
        "INVALID_ARGUMENT",
        name + " must not exceed " + maximum + " characters.",
      );
    }
    return value;
  }

  #requireMonitor(monitorId) {
    requireString(monitorId, "monitorId");
    const monitor = this.monitors.get(monitorId);
    if (!monitor) throw new SherpaError("MONITOR_NOT_FOUND", "Unknown monitorId: " + monitorId);
    return monitor;
  }

  #requireRevisionArtifact(monitor, revision) {
    const artifact = monitor.revisionArtifacts.get(revision);
    if (!artifact) {
      throw new SherpaError(
        "REVISION_NOT_AVAILABLE",
        "Revision " + revision + " is unavailable or has been purged.",
      );
    }
    return artifact;
  }

  #requireDiffArtifact(monitor, artifactId) {
    const artifact = monitor.diffArtifacts.get(artifactId);
    if (!artifact) {
      throw new SherpaError(
        "ARTIFACT_NOT_FOUND",
        "Unknown diffArtifactId for this monitor: " + artifactId,
      );
    }
    return artifact;
  }

  #requireFieldArtifact(monitor, artifactId) {
    const artifact = monitor.fieldArtifacts.get(artifactId);
    if (!artifact) {
      throw new SherpaError(
        "ARTIFACT_NOT_FOUND",
        "Unknown fieldArtifactId for this monitor: " + artifactId,
      );
    }
    return artifact;
  }

  #requireFeedbackArtifact(monitor, artifactId) {
    const artifact = monitor.feedbackArtifacts.get(artifactId);
    if (!artifact) {
      throw new SherpaError(
        "ARTIFACT_NOT_FOUND",
        "Unknown feedbackArtifactId for this monitor: " + artifactId,
      );
    }
    return artifact;
  }

  #assertCurrentRevision(monitor, revision, contentHash) {
    if (monitor.status !== "active") {
      throw new SherpaError(
        "MONITOR_NOT_ACTIVE",
        "Monitor is not active: " + monitor.id,
      );
    }
    const current = this.#requireRevisionArtifact(monitor, monitor.revision);
    if (
      revision !== monitor.revision ||
      contentHash !== monitor.currentContentHash ||
      contentHash !== current.contentHash
    ) {
      throw new SherpaError(
        "STALE_REVISION",
        "Expected current revision " +
          monitor.revision +
          " with contentHash " +
          monitor.currentContentHash +
          ".",
      );
    }
    return current;
  }

  #requireSourceArtifact(monitor, artifactId, revision, contentHash) {
    const revisionArtifact = monitor.revisionArtifactsById.get(artifactId);
    if (revisionArtifact) {
      if (
        revisionArtifact.revision !== revision ||
        revisionArtifact.contentHash !== contentHash
      ) {
        throw new SherpaError(
          "ARTIFACT_REVISION_MISMATCH",
          "Revision artifact does not match the requested CAS values.",
        );
      }
      return { kind: "revision", artifact: revisionArtifact };
    }
    const diffArtifact = monitor.diffArtifacts.get(artifactId);
    if (diffArtifact) {
      if (
        diffArtifact.revision !== revision ||
        diffArtifact.contentHash !== contentHash
      ) {
        throw new SherpaError(
          "ARTIFACT_REVISION_MISMATCH",
          "Diff artifact does not match the requested CAS values.",
        );
      }
      return { kind: "diff", artifact: diffArtifact };
    }
    throw new SherpaError(
      "ARTIFACT_NOT_FOUND",
      "Unknown sourceArtifactId for this monitor: " + artifactId,
    );
  }

  #selectReviewSource(monitor, revision, current) {
    if (revision === 0 || monitor.publishedRevision === revision) {
      return {
        source: { kind: "revision", artifact: current },
        rebaselineRequired: false,
      };
    }
    if (monitor.publishedRevision < 0) {
      return {
        source: { kind: "revision", artifact: current },
        rebaselineRequired: true,
      };
    }
    try {
      return {
        source: {
          kind: "diff",
          artifact: this.#createDiffArtifact(
            monitor,
            monitor.publishedRevision,
            revision,
          ),
        },
        rebaselineRequired: false,
      };
    } catch (error) {
      if (error.code !== "REVISION_NOT_AVAILABLE") throw error;
      return {
        source: { kind: "revision", artifact: current },
        rebaselineRequired: true,
      };
    }
  }

  #recentPublishedFeedback(monitor, revision, feedbackLimit) {
    const recentPublishedFeedback = [];
    let remainingCharacters = MAX_REVIEW_HISTORY_CHARACTERS;
    const candidateIds = monitor.publishedFeedbackIds.slice(-feedbackLimit);
    for (let index = candidateIds.length - 1; index >= 0; index -= 1) {
      const artifact = monitor.feedbackArtifacts.get(candidateIds[index]);
      if (
        !artifact ||
        artifact.revision >= revision ||
        typeof artifact.feedback !== "string" ||
        artifact.feedback.length === 0 ||
        remainingCharacters <= 0
      ) {
        continue;
      }
      const feedback =
        artifact.feedback.length <= remainingCharacters
          ? artifact.feedback
          : artifact.feedback.slice(artifact.feedback.length - remainingCharacters);
      remainingCharacters -= feedback.length;
      recentPublishedFeedback.unshift({
        feedbackArtifactId: artifact.id,
        revision: artifact.revision,
        feedback,
        publishedAt: artifact.publishedAt,
      });
    }
    return recentPublishedFeedback;
  }

  #acquireReviewLease(monitor, revision, contentHash, sourceArtifactId) {
    const nowMs = this.now();
    const currentLease = monitor.reviewLease;
    if (
      currentLease &&
      currentLease.expiresAtMs > nowMs &&
      currentLease.revision === revision &&
      currentLease.contentHash === contentHash &&
      currentLease.sourceArtifactId === sourceArtifactId
    ) {
      return currentLease;
    }
    this.#clearReviewLease(monitor);
    clearTimeout(monitor.idleTimer);
    monitor.idleTimer = null;
    monitor.idleWarningIssued = false;
    monitor.idleWarningPending = false;
    monitor.idleWarningDelivered = false;
    const lease = {
      token: "review-" + randomUUID(),
      revision,
      contentHash,
      sourceArtifactId,
      expectedPublishedRevision: monitor.publishedRevision,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + this.reviewLeaseMs,
      timer: null,
    };
    lease.timer = setTimeout(
      () => this.#expireReviewLease(monitor, lease.token),
      this.reviewLeaseMs,
    );
    lease.timer.unref?.();
    monitor.reviewLease = lease;
    return lease;
  }

  #clearReviewLease(monitor) {
    if (!monitor.reviewLease) return;
    clearTimeout(monitor.reviewLease.timer);
    monitor.reviewLease.timer = null;
    monitor.reviewLease = null;
  }

  #expireReviewLease(monitor, reviewToken) {
    if (monitor.reviewLease?.token !== reviewToken) return;
    this.#clearReviewLease(monitor);
    if (monitor.status === "active") this.#restartIdleClock(monitor, this.now());
  }

  #restartIdleClock(monitor, startedAtMs = this.now()) {
    monitor.lastContentActivityAtMs = startedAtMs;
    monitor.idleWarningIssued = false;
    monitor.idleWarningPending = false;
    monitor.idleWarningDelivered = false;
    this.#scheduleIdleTimer(monitor);
  }

  #assertFieldMatches(fieldArtifact, revision, contentHash, sourceArtifactId) {
    if (
      fieldArtifact.revision !== revision ||
      fieldArtifact.contentHash !== contentHash ||
      fieldArtifact.sourceArtifactId !== sourceArtifactId
    ) {
      throw new SherpaError(
        "ARTIFACT_REVISION_MISMATCH",
        "Field artifact does not match the requested revision, hash, and source.",
      );
    }
  }

  #publicFieldArtifact(artifact) {
    return {
      fieldArtifactId: artifact.id,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      sourceArtifactId: artifact.sourceArtifactId,
      field: artifact.field,
      analysis: artifact.analysis,
      createdAt: artifact.createdAt,
    };
  }

  #publicFeedbackArtifact(artifact) {
    return {
      feedbackArtifactId: artifact.id,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      sourceArtifactId: artifact.sourceArtifactId,
      fieldArtifactId: artifact.fieldArtifactId,
      feedback: artifact.feedback,
      state: artifact.state,
      createdAt: artifact.createdAt,
      publishedAt: artifact.publishedAt,
    };
  }

  #status(monitor) {
    const current = monitor.revisionArtifacts.get(monitor.revision);
    const lease = monitor.reviewLease;
    return {
      monitorId: monitor.id,
      path: monitor.path,
      status: monitor.status,
      reason: monitor.reason,
      error: monitor.error,
      purged: monitor.purged,
      revision: monitor.revision,
      revisionArtifactId: current?.id ?? null,
      contentHash: monitor.purged ? null : monitor.currentContentHash,
      metadata: monitor.purged ? null : publicMetadata(monitor.observedSnapshot?.metadata),
      saveSequence: monitor.saveSequence,
      pollIntervalMs: monitor.pollIntervalMs,
      contextLines: monitor.contextLines,
      startedAt: monitor.startedAt,
      lastEventAt: monitor.lastEventAt,
      lastSaveAt: monitor.lastSaveAt,
      publishedRevision: monitor.publishedRevision,
      missingProbeCount: monitor.missingProbes,
      promptPresent: !monitor.purged && monitor.prompt.length > 0,
      promptRef: monitor.purged ? null : monitor.promptRef,
      idleWarningIssued: monitor.idleWarningIssued,
      idleForMs: Math.max(0, this.now() - monitor.lastContentActivityAtMs),
      idleSuspended: Boolean(lease),
      reviewLeaseMs: this.reviewLeaseMs,
      reviewLease: lease
        ? {
            active: true,
            revision: lease.revision,
            contentHash: lease.contentHash,
            sourceArtifactId: lease.sourceArtifactId,
            startedAt: new Date(lease.startedAtMs).toISOString(),
            expiresAt: new Date(lease.expiresAtMs).toISOString(),
            remainingMs: Math.max(0, lease.expiresAtMs - this.now()),
          }
        : { active: false },
    };
  }

  #storeRevisionArtifact(monitor, revision, snapshot) {
    const artifact = {
      id: "revision-" + monitor.id + "-" + revision,
      revision,
      contentHash: computeContentHash(snapshot.text),
      snapshot,
      createdAt: new Date(this.now()).toISOString(),
    };
    monitor.revisionArtifacts.set(revision, artifact);
    monitor.revisionArtifactsById.set(artifact.id, artifact);
    return artifact;
  }

  #createDiffArtifact(monitor, fromRevision, revision) {
    const rangeKey = fromRevision + ":" + revision;
    const existingId = monitor.diffArtifactsByRange.get(rangeKey);
    if (existingId) return this.#requireDiffArtifact(monitor, existingId);
    const previous = this.#requireRevisionArtifact(monitor, fromRevision);
    const current = this.#requireRevisionArtifact(monitor, revision);
    const delta = computeLineDelta(
      previous.snapshot.text,
      current.snapshot.text,
      monitor.contextLines,
    );
    const artifact = {
      id: "diff-" + monitor.id + "-" + fromRevision + "-" + revision,
      fromRevision,
      revision,
      fromContentHash: previous.contentHash,
      contentHash: current.contentHash,
      excerpt: formatDiffExcerpt(delta),
      changedRanges: changedRanges(delta),
      delta: deltaReference(delta),
      createdAt: new Date(this.now()).toISOString(),
    };
    monitor.diffArtifacts.set(artifact.id, artifact);
    monitor.diffArtifactsByRange.set(rangeKey, artifact.id);
    this.#pruneDiffArtifacts(monitor, artifact.id);
    return artifact;
  }

  #saveResult(monitor, afterRevision) {
    const current = this.#requireRevisionArtifact(monitor, monitor.revision);
    const latestEvent = monitor.events.at(-1);
    let diffArtifact = null;
    let rebaselineRequired = false;
    try {
      diffArtifact = this.#createDiffArtifact(
        monitor,
        afterRevision,
        monitor.revision,
      );
    } catch (error) {
      if (error.code !== "REVISION_NOT_AVAILABLE") throw error;
      rebaselineRequired = true;
    }
    const reviewContext =
      monitor.publishedRevision < monitor.revision
        ? this.#inlineReviewContext(monitor, monitor.revision)
        : null;
    return {
      state: "saved",
      rebaselineRequired: reviewContext?.rebaselineRequired ?? rebaselineRequired,
      event: {
        type: latestEvent?.type ?? "changed",
        monitorId: monitor.id,
        path: monitor.path,
        saveSequence: latestEvent?.saveSequence ?? monitor.saveSequence,
        fromRevision: afterRevision,
        revision: monitor.revision,
        revisionArtifactId: current.id,
        diffArtifactId: diffArtifact?.id ?? null,
        contentHash: current.contentHash,
        changedRanges: diffArtifact?.changedRanges ?? [],
        delta: diffArtifact?.delta ?? null,
        observedAt: latestEvent?.observedAt ?? monitor.lastEventAt,
        metadata: publicMetadata(monitor.observedSnapshot?.metadata),
      },
      reviewContext,
    };
  }

  #restartPollTimer(monitor) {
    clearInterval(monitor.pollTimer);
    monitor.pollTimer = setInterval(() => {
      void this.#poll(monitor);
    }, monitor.pollIntervalMs);
    monitor.pollTimer.unref?.();
  }

  async #poll(monitor) {
    if (monitor.status !== "active" || monitor.polling) return;
    monitor.polling = true;
    try {
      const metadata = await probeMetadata(monitor.path);
      monitor.missingProbes = 0;
      if (
        monitor.observedSnapshot?.metadata &&
        metadataSignature(metadata) ===
          metadataSignature(monitor.observedSnapshot.metadata)
      ) {
        return;
      }

      const previousObserved = monitor.observedSnapshot;
      const current = await readStablePath(monitor.path, READ_RETRY_DELAY_MS);
      if (
        previousObserved?.metadata &&
        metadataSignature(current.metadata) ===
          metadataSignature(previousObserved.metadata)
      ) {
        return;
      }

      monitor.observedSnapshot = current;
      monitor.saveSequence += 1;
      monitor.lastSaveAt = new Date(this.now()).toISOString();
      monitor.saveRecords.push({
        saveSequence: monitor.saveSequence,
        metadata: current.metadata,
        contentHash: computeContentHash(current.text),
        savedAt: monitor.lastSaveAt,
      });
      if (monitor.saveRecords.length > MAX_EVENT_HISTORY) monitor.saveRecords.shift();

      const nextContentHash = computeContentHash(current.text);
      if (nextContentHash === monitor.currentContentHash) return;
      this.#markContentActivity(monitor);

      const replaced =
        previousObserved?.metadata &&
        identitySignature(previousObserved.metadata) !==
          identitySignature(current.metadata);
      const previousRevision = monitor.revision;
      monitor.revision += 1;
      monitor.currentContentHash = nextContentHash;
      const revisionArtifact = this.#storeRevisionArtifact(
        monitor,
        monitor.revision,
        current,
      );
      const diffArtifact = this.#createDiffArtifact(
        monitor,
        previousRevision,
        monitor.revision,
      );
      const event = {
        type: replaced ? "replaced" : "changed",
        monitorId: monitor.id,
        path: monitor.path,
        saveSequence: monitor.saveSequence,
        revision: monitor.revision,
        revisionArtifactId: revisionArtifact.id,
        diffArtifactId: diffArtifact.id,
        contentHash: nextContentHash,
        observedAt: new Date(this.now()).toISOString(),
        metadata: publicMetadata(current.metadata),
      };
      this.#emit(monitor, event);
      this.#pruneArtifacts(monitor);
    } catch (error) {
      if (error.code === "TARGET_NOT_FOUND") {
        monitor.missingProbes += 1;
        if (monitor.missingProbes >= 2) {
          this.#stop(monitor, "target-deleted", "stopped", "deleted");
        }
      } else if (error.code === "TARGET_CHANGED_DURING_READ") {
        return;
      } else {
        this.#fail(monitor, error);
      }
    } finally {
      monitor.polling = false;
    }
  }

  #emit(monitor, event) {
    monitor.lastEventAt = event.observedAt;
    monitor.events.push(event);
    if (monitor.events.length > MAX_EVENT_HISTORY) monitor.events.shift();
    for (const waiter of [...monitor.waiters]) {
      if (event.revision > waiter.afterRevision) {
        waiter.resolve(this.#saveResult(monitor, waiter.afterRevision));
      }
    }
  }

  #pruneArtifacts(monitor) {
    while (monitor.revisionArtifacts.size > MAX_EVENT_HISTORY + 2) {
      const removable = [...monitor.revisionArtifacts.keys()].find(
        (candidate) => candidate !== monitor.revision,
      );
      if (removable === undefined) break;
      const artifact = monitor.revisionArtifacts.get(removable);
      monitor.revisionArtifacts.delete(removable);
      monitor.revisionArtifactsById.delete(artifact.id);

      const fieldArtifactId = monitor.fieldArtifactByRevision.get(removable);
      if (fieldArtifactId) {
        monitor.fieldArtifactByRevision.delete(removable);
        monitor.fieldArtifacts.delete(fieldArtifactId);
      }
      const feedbackArtifactId = monitor.feedbackArtifactByRevision.get(removable);
      if (feedbackArtifactId) {
        monitor.feedbackArtifactByRevision.delete(removable);
        monitor.feedbackArtifacts.delete(feedbackArtifactId);
        monitor.publishedFeedbackIds = monitor.publishedFeedbackIds.filter(
          (candidate) => candidate !== feedbackArtifactId,
        );
      }
    }

    for (const [artifactId, artifact] of monitor.diffArtifacts) {
      if (
        !monitor.revisionArtifacts.has(artifact.fromRevision) ||
        !monitor.revisionArtifacts.has(artifact.revision)
      ) {
        monitor.diffArtifacts.delete(artifactId);
        monitor.diffArtifactsByRange.delete(
          artifact.fromRevision + ":" + artifact.revision,
        );
      }
    }
    this.#pruneDiffArtifacts(monitor);
  }

  #pruneDiffArtifacts(monitor, protectedArtifactId = undefined) {
    while (monitor.diffArtifacts.size > MAX_DIFF_ARTIFACTS) {
      const referenced = new Set([
        ...[...monitor.fieldArtifacts.values()].map((artifact) => artifact.sourceArtifactId),
        ...[...monitor.feedbackArtifacts.values()].map((artifact) => artifact.sourceArtifactId),
      ]);
      const removable = [...monitor.diffArtifacts.entries()].find(
        ([artifactId]) =>
          artifactId !== protectedArtifactId && !referenced.has(artifactId),
      );
      if (!removable) break;
      const [artifactId, artifact] = removable;
      monitor.diffArtifacts.delete(artifactId);
      monitor.diffArtifactsByRange.delete(
        artifact.fromRevision + ":" + artifact.revision,
      );
    }
  }

  #markContentActivity(monitor) {
    this.#clearReviewLease(monitor);
    this.#restartIdleClock(monitor, this.now());
  }

  #scheduleIdleTimer(monitor) {
    clearTimeout(monitor.idleTimer);
    monitor.idleTimer = null;
    if (monitor.status !== "active" || monitor.reviewLease) return;
    const elapsed = Math.max(0, this.now() - monitor.lastContentActivityAtMs);
    const threshold = monitor.idleWarningIssued ? this.idleStopMs : this.idleWarningMs;
    const delay = Math.max(1, threshold - elapsed);
    monitor.idleTimer = setTimeout(() => this.#handleIdleTimer(monitor), delay);
    monitor.idleTimer.unref?.();
  }

  #handleIdleTimer(monitor) {
    if (monitor.status !== "active" || monitor.reviewLease) return;
    const elapsed = Math.max(0, this.now() - monitor.lastContentActivityAtMs);
    if (!monitor.idleWarningIssued && elapsed >= this.idleWarningMs) {
      monitor.idleWarningIssued = true;
      monitor.idleWarningPending = true;
      let delivered = false;
      for (const waiter of [...monitor.waiters]) {
        waiter.resolve(this.#idleWarningResult(monitor));
        delivered = true;
      }
      if (delivered) {
        monitor.idleWarningPending = false;
        monitor.idleWarningDelivered = true;
      }
      this.#scheduleIdleTimer(monitor);
      return;
    }
    if (monitor.idleWarningIssued && elapsed >= this.idleStopMs) {
      this.#stop(monitor, "idle-timeout", "stopped", "idle-stopped");
      return;
    }
    this.#scheduleIdleTimer(monitor);
  }

  #idleWarningResult(monitor) {
    const idleForMs = Math.max(0, this.now() - monitor.lastContentActivityAtMs);
    return {
      state: "idle-warning",
      monitorId: monitor.id,
      revision: monitor.revision,
      saveSequence: monitor.saveSequence,
      status: monitor.status,
      idleForMs,
      stopInMs: Math.max(0, this.idleStopMs - idleForMs),
      message: IDLE_WARNING_MESSAGE,
    };
  }

  #fail(monitor, error) {
    const normalized = translateFileError(error, monitor.path);
    monitor.error = {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    };
    this.#stop(monitor, "runtime-failed", "error", "error");
  }

  #purge(monitor) {
    if (monitor.purged) return;
    this.#clearReviewLease(monitor);
    monitor.prompt = "";
    monitor.promptHash = null;
    monitor.promptRef = null;
    monitor.observedSnapshot = null;
    monitor.currentContentHash = null;
    monitor.revisionArtifacts.clear();
    monitor.revisionArtifactsById.clear();
    monitor.diffArtifacts.clear();
    monitor.diffArtifactsByRange.clear();
    monitor.fieldArtifacts.clear();
    monitor.fieldArtifactByRevision.clear();
    monitor.feedbackArtifacts.clear();
    monitor.feedbackArtifactByRevision.clear();
    monitor.publishedFeedbackIds.length = 0;
    monitor.saveRecords.length = 0;
    monitor.events.length = 0;
    monitor.purged = true;
  }

  #stop(monitor, reason, status, stateOverride = undefined) {
    clearInterval(monitor.pollTimer);
    clearTimeout(monitor.idleTimer);
    this.#clearReviewLease(monitor);
    monitor.pollTimer = null;
    monitor.idleTimer = null;
    monitor.status = status;
    monitor.reason = reason;
    if (this.activeByPath.get(monitor.path) === monitor.id) {
      this.activeByPath.delete(monitor.path);
    }
    this.#purge(monitor);
    const result = {
      state:
        stateOverride ??
        (status === "error"
          ? "error"
          : reason === "idle-timeout"
            ? "idle-stopped"
            : "stopped"),
      ...this.#status(monitor),
    };
    for (const waiter of [...monitor.waiters]) waiter.resolve(result);
  }
}
function compactToolSummary(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: true };
  }
  if (Array.isArray(data.monitors)) {
    return { ok: true, monitorCount: data.monitors.length };
  }
  const summary = { ok: true };
  for (const key of [
    "state",
    "monitorId",
    "status",
    "reason",
    "purged",
    "revision",
    "contentHash",
    "reviewToken",
    "sourceArtifactId",
    "sourceKind",
    "rebaselineRequired",
    "feedbackArtifactId",
    "publishedRevision",
    "reused",
  ]) {
    if (Object.hasOwn(data, key)) summary[key] = data[key];
  }
  if (data.event && typeof data.event === "object") {
    summary.event = {};
    for (const key of [
      "type",
      "revision",
      "contentHash",
      "revisionArtifactId",
      "diffArtifactId",
    ]) {
      if (Object.hasOwn(data.event, key)) summary.event[key] = data.event[key];
    }
  }
  if (data.reviewContext && typeof data.reviewContext === "object") {
    summary.reviewContext = {};
    for (const key of [
      "state",
      "reviewToken",
      "revision",
      "contentHash",
      "sourceKind",
      "rebaselineRequired",
    ]) {
      if (Object.hasOwn(data.reviewContext, key)) {
        summary.reviewContext[key] = data.reviewContext[key];
      }
    }
    if (data.reviewContext.input && typeof data.reviewContext.input === "object") {
      summary.reviewContext.input = { kind: data.reviewContext.input.kind };
    }
  } else if (Object.hasOwn(data, "reviewContext")) {
    summary.reviewContext = null;
  }
  return summary;
}

function toolSuccess(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(compactToolSummary(data)) }],
    structuredContent: data,
  };
}

function toolFailure(error) {
  const normalized =
    error instanceof SherpaError
      ? error
      : new SherpaError("INTERNAL_ERROR", error?.message ?? String(error));
  const data = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

export async function callTool(session, name, args, signal = undefined) {
  try {
    let result;
    switch (name) {
      case "start_monitor":
        result = await session.startMonitor(args);
        break;
      case "read_review_context":
        result = session.readReviewContext(args);
        break;
      case "publish_feedback":
        result = session.publishFeedback(args);
        break;
      case "wait_for_save":
        result = await session.waitForSave(args, signal);
        break;
      case "get_status":
        result = session.getStatus(args);
        break;
      case "stop_monitor":
        result = session.stopMonitor(args);
        break;
      default:
        throw new SherpaError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
    }
    return toolSuccess(result);
  } catch (error) {
    return toolFailure(error);
  }
}

function jsonRpcError(id, code, message, data = undefined) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function createMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const session = new MonitorSession();
  const inFlight = new Map();
  let initialized = false;
  let closed = false;

  const send = (message) => {
    if (!closed) output.write(`${JSON.stringify(message)}\n`);
  };

  const handle = async (message) => {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        send(jsonRpcError(null, -32600, "Invalid Request"));
        return;
      }
      for (const item of message) void handle(item);
      return;
    }
    if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0") {
      send(jsonRpcError(null, -32600, "Invalid Request"));
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = hasId ? message.id : undefined;
    const method = message.method;
    if (typeof method !== "string") {
      if (hasId) send(jsonRpcError(id, -32600, "Invalid Request"));
      return;
    }

    if (method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      inFlight.get(JSON.stringify(requestId))?.abort();
      return;
    }
    if (method === "notifications/initialized") {
      initialized = true;
      return;
    }
    if (!hasId) return;

    const controller = new AbortController();
    const requestKey = JSON.stringify(id);
    inFlight.set(requestKey, controller);
    try {
      switch (method) {
        case "initialize": {
          const requested = message.params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          send(
            jsonRpcResult(id, {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
              instructions:
                "Sherpa 0.6 uses exactly six tools. start_monitor and saved wait_for_save results carry reviewContext inline; read_review_context is recovery-only. Review on the current host, show concise feedback once, then publish its revision/hash/token without repeating the feedback body. Do not use subagents because session memory is process-local. Sherpa reads only explicitly selected UTF-8 regular files and never writes to the target or workspace.",
            }),
          );
          break;
        }
        case "ping":
          send(jsonRpcResult(id, {}));
          break;
        case "tools/list":
          send(jsonRpcResult(id, { tools: TOOL_DEFINITIONS }));
          break;
        case "tools/call": {
          if (!initialized) {
            send(jsonRpcError(id, -32002, "Server is not initialized"));
            break;
          }
          const params = assertObject(message.params, "params");
          const name = requireString(params.name, "name");
          const result = await callTool(session, name, params.arguments ?? {}, controller.signal);
          send(jsonRpcResult(id, result));
          break;
        }
        default:
          send(jsonRpcError(id, -32601, "Method not found"));
      }
    } catch (error) {
      send(jsonRpcError(id, -32602, error.message));
    } finally {
      inFlight.delete(requestKey);
    }
  };

  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      send(jsonRpcError(null, -32700, "Parse error", error.message));
    }
  });
  lines.on("close", () => {
    closed = true;
    for (const controller of inFlight.values()) controller.abort();
    session.close();
  });

  return {
    session,
    close() {
      if (closed) return;
      lines.close();
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) createMcpServer();
