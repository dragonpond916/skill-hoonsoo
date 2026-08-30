#!/usr/bin/env node

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
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
export const IDLE_WARNING_MESSAGE =
  "1분 간, 작업이 감지되지 않습니다. 추가 30초 대기 후, 훈수모드가 정지됩니다.\n" +
  "추후 다시 훈수모드를 켜시려면 스킬을 다시 실행해주세요.";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SETTLE_MS = 3_000;
const READ_RETRY_DELAY_MS = 25;
const DEFAULT_CONTEXT_LINES = 5;
const MAX_EVENT_HISTORY = 64;
const MAX_FINE_DIFF_LINES = 100_000;
const MAX_LCS_CELLS = 1_000_000;
const MAX_LCS_OPERATION_LINES = 10_000;
const MAX_DELTA_LINES = 200;
const MAX_DELTA_TEXT_CHARACTERS = 12_000;
const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SERVER_NAME = "hoonsoo";
const SERVER_VERSION = "0.2.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL_DEFINITIONS = [
  {
    name: "start_monitor",
    description:
      "Start an in-memory, read-only monitor for one UTF-8 regular file. The path must be absolute. This tool never writes to the target or workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path to the regular file." },
        pollIntervalMs: { type: "integer", minimum: 25, maximum: 60_000, default: 2_000 },
        settleMs: { type: "integer", minimum: 0, maximum: 10_000, default: 3_000 },
        contextLines: { type: "integer", minimum: 0, maximum: 50, default: 5 },
      },
    },
    annotations: {
      title: "Start Hoonsoo monitor",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "read_snapshot",
    description:
      "Read one bounded page from the monitor's current in-memory snapshot. Use nextOffset until hasMore is false.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["monitorId"],
      properties: {
        monitorId: { type: "string" },
        offset: { type: "integer", minimum: 0, default: 0 },
        maxCharacters: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SNAPSHOT_CHARACTERS,
          default: DEFAULT_SNAPSHOT_CHARACTERS,
        },
      },
    },
    annotations: {
      title: "Read Hoonsoo snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "wait_for_change",
    description:
      "Wait locally until a meaningful content change, the 60-second idle warning, the 90-second idle stop, cancellation, or an optional timeout. Omit timeoutMs to avoid periodic model wake-ups.",
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
      title: "Wait for Hoonsoo change",
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
      title: "Get Hoonsoo status",
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
      title: "Stop Hoonsoo monitor",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export class HoonsooError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "HoonsooError";
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
    throw new HoonsooError("INVALID_ARGUMENT", `${label} must be an object.`);
  }
  return value;
}

function integerOption(value, name, fallback, minimum, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new HoonsooError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return resolved;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HoonsooError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
  }
  return value;
}

export function normalizeTargetPath(inputPath) {
  requireString(inputPath, "path");
  if (inputPath.includes("\0")) {
    throw new HoonsooError("INVALID_PATH", "path must not contain a NUL byte.");
  }
  if (!path.isAbsolute(inputPath)) {
    throw new HoonsooError("INVALID_PATH", "path must be absolute.");
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
    device: metadata.dev,
    inode: metadata.ino,
  };
}

function translateFileError(error, targetPath) {
  if (error instanceof HoonsooError) return error;
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return new HoonsooError("TARGET_NOT_FOUND", `Target does not exist: ${targetPath}`);
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new HoonsooError("TARGET_NOT_READABLE", `Target is not readable: ${targetPath}`);
  }
  return new HoonsooError("TARGET_READ_FAILED", `Failed to read target: ${targetPath}`, {
    cause: error?.code ?? error?.message ?? String(error),
  });
}

async function probeMetadata(targetPath) {
  try {
    const fileStat = await stat(targetPath, { bigint: true });
    if (!fileStat.isFile()) {
      throw new HoonsooError("TARGET_NOT_REGULAR_FILE", `Target must be a regular file: ${targetPath}`);
    }
    if (fileStat.size > BigInt(MAX_FILE_BYTES)) {
      throw new HoonsooError(
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
      throw new HoonsooError(
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
    throw new HoonsooError("TARGET_NOT_UTF8", `Target is not valid UTF-8: ${targetPath}`);
  }
}

async function readPathOnce(targetPath) {
  let fileHandle;
  try {
    fileHandle = await open(targetPath, "r");
    const beforeStat = await fileHandle.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw new HoonsooError("TARGET_NOT_REGULAR_FILE", `Target must be a regular file: ${targetPath}`);
    }
    if (beforeStat.size > BigInt(MAX_FILE_BYTES)) {
      throw new HoonsooError(
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
      throw new HoonsooError("TARGET_CHANGED_DURING_READ", `Target changed while being read: ${targetPath}`);
    }
    return { text, metadata: after };
  } catch (error) {
    throw translateFileError(error, targetPath);
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function readStablePath(targetPath, settleMs, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readPathOnce(targetPath);
    } catch (error) {
      lastError = error;
      if (error.code !== "TARGET_CHANGED_DURING_READ" || attempt === attempts - 1) throw error;
      await sleep(settleMs);
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

export function normalizeMeaningfulText(text) {
  return text.replace(/\s/gu, "");
}

function semanticHash(text) {
  return createHash("sha256").update(normalizeMeaningfulText(text), "utf8").digest("hex");
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

  outer: for (const hunk of delta.hunks) {
    const lines = [];
    for (const line of hunk.lines) {
      if (includedLines >= MAX_DELTA_LINES) {
        truncated = true;
        break outer;
      }
      const remaining = MAX_DELTA_TEXT_CHARACTERS - includedTextCharacters;
      if (remaining <= 0) {
        truncated = true;
        break outer;
      }
      let text = line.text;
      if (text.length > remaining) {
        text = `${text.slice(0, Math.max(0, remaining - 1))}…`;
        truncated = true;
      }
      lines.push({ ...line, text });
      includedLines += 1;
      includedTextCharacters += text.length;
      if (text.length !== line.text.length) break outer;
    }
    if (lines.length > 0) hunks.push({ ...hunk, lines });
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

export function computeMeaningfulLineDelta(
  previousText,
  currentText,
  contextLines = DEFAULT_CONTEXT_LINES,
) {
  if (semanticHash(previousText) === semanticHash(currentText)) {
    return computeLineDelta(previousText, previousText, contextLines);
  }

  const delta = computeLineDelta(previousText, currentText, contextLines);
  const hunks = delta.hunks.filter((hunk) => {
    const deleted = hunk.lines
      .filter((line) => line.type === "delete")
      .map((line) => line.text)
      .join("\n");
    const added = hunk.lines
      .filter((line) => line.type === "add")
      .map((line) => line.text)
      .join("\n");
    return normalizeMeaningfulText(deleted) !== normalizeMeaningfulText(added);
  });
  const retainedLines = hunks.flatMap((hunk) => hunk.lines);
  return {
    ...delta,
    hunks,
    additions: retainedLines.filter((line) => line.type === "add").length,
    deletions: retainedLines.filter((line) => line.type === "delete").length,
    includedLineOperations: retainedLines.length,
  };
}

function changedRanges(delta) {
  return delta.hunks.map((hunk) => ({
    startLine: hunk.newStart,
    endLine: Math.max(hunk.newStart, hunk.newStart + Math.max(0, hunk.newCount - 1)),
  }));
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
    throw new HoonsooError(
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
      throw new HoonsooError("INVALID_ARGUMENT", "idleStopMs must be greater than idleWarningMs.");
    }
    this.now = args.now ?? Date.now;
    if (typeof this.now !== "function") {
      throw new HoonsooError("INVALID_ARGUMENT", "now must be a function.");
    }
    this.monitors = new Map();
    this.activeByPath = new Map();
    this.nextMonitorNumber = 1;
    this.closed = false;
  }

  async startMonitor(input) {
    const args = assertObject(input);
    const targetPath = normalizeTargetPath(args.path);
    const pollIntervalMs = integerOption(
      args.pollIntervalMs,
      "pollIntervalMs",
      DEFAULT_POLL_INTERVAL_MS,
      25,
      60_000,
    );
    const settleMs = integerOption(args.settleMs, "settleMs", DEFAULT_SETTLE_MS, 0, 10_000);
    const contextLines = integerOption(
      args.contextLines,
      "contextLines",
      DEFAULT_CONTEXT_LINES,
      0,
      50,
    );

    const activeId = this.activeByPath.get(targetPath);
    const active = activeId ? this.monitors.get(activeId) : undefined;
    if (active?.status === "active") {
      active.pollIntervalMs = pollIntervalMs;
      active.settleMs = settleMs;
      active.contextLines = contextLines;
      this.#restartPollTimer(active);
      return { ...this.#status(active), reused: true };
    }

    const snapshot = await readStablePath(targetPath, READ_RETRY_DELAY_MS);
    const snapshotHash = semanticHash(snapshot.text);
    const startedAtMs = this.now();
    const monitor = {
      id: `monitor-${this.nextMonitorNumber++}`,
      path: targetPath,
      status: "active",
      reason: null,
      error: null,
      revision: 0,
      observedSnapshot: snapshot,
      observedSemanticHash: snapshotHash,
      revisionSnapshot: snapshot,
      revisionSemanticHash: snapshotHash,
      analysisBaselineRevision: 0,
      analysisBaselineSnapshot: snapshot,
      revisionSnapshots: new Map([[0, snapshot]]),
      pollIntervalMs,
      settleMs,
      contextLines,
      startedAt: new Date(startedAtMs).toISOString(),
      lastEventAt: null,
      lastMeaningfulActivityAtMs: startedAtMs,
      idleWarningIssued: false,
      idleWarningPending: false,
      idleWarningDelivered: false,
      events: [],
      waiters: new Set(),
      pollTimer: null,
      settleTimer: null,
      idleTimer: null,
      pendingKey: null,
      pendingMeaningfulChange: false,
      polling: false,
      settling: false,
    };
    this.monitors.set(monitor.id, monitor);
    this.activeByPath.set(targetPath, monitor.id);
    this.#restartPollTimer(monitor);
    this.#scheduleIdleTimer(monitor);
    return { ...this.#status(monitor), reused: false };
  }

  readSnapshot(input) {
    const args = assertObject(input);
    const monitor = this.#requireMonitor(args.monitorId);
    const offset = integerOption(args.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const maxCharacters = integerOption(
      args.maxCharacters,
      "maxCharacters",
      DEFAULT_SNAPSHOT_CHARACTERS,
      1,
      MAX_SNAPSHOT_CHARACTERS,
    );
    return {
      monitorId: monitor.id,
      path: monitor.path,
      revision: monitor.revision,
      status: monitor.status,
      semanticHash: monitor.revisionSemanticHash,
      metadata: publicMetadata(monitor.revisionSnapshot.metadata),
      ...pageText(monitor.revisionSnapshot.text, offset, maxCharacters),
    };
  }

  waitForChange(input, signal = undefined) {
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
      throw new HoonsooError(
        "REVISION_AHEAD",
        `afterRevision ${afterRevision} is ahead of current revision ${monitor.revision}. Re-read status or snapshot before waiting.`,
      );
    }
    this.#acknowledgeHandledRevision(monitor, afterRevision);
    let event;
    for (let index = monitor.events.length - 1; index >= 0; index -= 1) {
      if (monitor.events[index].revision > afterRevision) {
        event = monitor.events[index];
        break;
      }
    }
    if (event && !monitor.pendingMeaningfulChange) {
      return Promise.resolve(this.#eventResult(monitor, event, afterRevision));
    }
    if (monitor.status === "error") {
      return Promise.resolve({ state: "error", ...this.#status(monitor) });
    }
    if (monitor.status !== "active") {
      return Promise.resolve({
        state: monitor.reason === "idle-timeout" ? "idle-stopped" : "stopped",
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
            status: monitor.status,
          });
        }, timeoutMs);
      }
      monitor.waiters.add(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
    });
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
    }
  }

  #requireMonitor(monitorId) {
    requireString(monitorId, "monitorId");
    const monitor = this.monitors.get(monitorId);
    if (!monitor) throw new HoonsooError("MONITOR_NOT_FOUND", `Unknown monitorId: ${monitorId}`);
    return monitor;
  }

  #status(monitor) {
    return {
      monitorId: monitor.id,
      path: monitor.path,
      status: monitor.status,
      reason: monitor.reason,
      error: monitor.error,
      revision: monitor.revision,
      semanticHash: monitor.revisionSemanticHash,
      metadata: publicMetadata(monitor.revisionSnapshot.metadata),
      observedMetadata: publicMetadata(monitor.observedSnapshot.metadata),
      pollIntervalMs: monitor.pollIntervalMs,
      settleMs: monitor.settleMs,
      contextLines: monitor.contextLines,
      startedAt: monitor.startedAt,
      lastEventAt: monitor.lastEventAt,
      analysisBaselineRevision: monitor.analysisBaselineRevision,
      pendingMeaningfulChange: monitor.pendingMeaningfulChange,
      idleWarningIssued: monitor.idleWarningIssued,
      idleForMs: Math.max(0, this.now() - monitor.lastMeaningfulActivityAtMs),
    };
  }

  #acknowledgeHandledRevision(monitor, revision) {
    if (revision <= monitor.analysisBaselineRevision) return;
    const snapshot =
      monitor.revisionSnapshots.get(revision) ??
      (revision === monitor.revision ? monitor.revisionSnapshot : undefined);
    if (!snapshot) return;
    monitor.analysisBaselineRevision = revision;
    monitor.analysisBaselineSnapshot = snapshot;
  }

  #eventResult(monitor, event, afterRevision) {
    const snapshot =
      monitor.revisionSnapshots.get(event.revision) ??
      (event.revision === monitor.revision ? monitor.revisionSnapshot : undefined);
    if (!snapshot) {
      return {
        state: "changed",
        historyTruncated: true,
        rebaselineRequired: true,
        event: { ...event, delta: null, changedRanges: [] },
      };
    }
    const delta = computeMeaningfulLineDelta(
      monitor.analysisBaselineSnapshot.text,
      snapshot.text,
      monitor.contextLines,
    );
    const historyTruncated = monitor.events[0]?.revision > afterRevision + 1;
    return {
      state: "changed",
      historyTruncated,
      rebaselineRequired: historyTruncated || delta.truncated,
      event: {
        ...event,
        previousRevision: monitor.analysisBaselineRevision,
        fromRevision: monitor.analysisBaselineRevision,
        semanticHash: semanticHash(snapshot.text),
        changedRanges: changedRanges(delta),
        delta: deltaReference(delta),
      },
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
    if (monitor.status !== "active" || monitor.polling || monitor.settling) return;
    monitor.polling = true;
    try {
      const metadata = await probeMetadata(monitor.path);
      if (
        monitor.observedSnapshot.metadata &&
        metadataSignature(metadata) === metadataSignature(monitor.observedSnapshot.metadata)
      ) return;

      const current = await readPathOnce(monitor.path);
      const previousHash = monitor.observedSemanticHash;
      const currentHash = semanticHash(current.text);
      monitor.observedSnapshot = current;
      monitor.observedSemanticHash = currentHash;
      if (currentHash === previousHash) return;

      monitor.pendingMeaningfulChange = true;
      this.#markMeaningfulActivity(monitor);
      this.#scheduleSettle(monitor, `present:${currentHash}`);
    } catch (error) {
      if (error.code === "TARGET_NOT_FOUND") {
        if (monitor.observedSnapshot.metadata !== null) {
          monitor.observedSnapshot = { text: "", metadata: null };
          monitor.observedSemanticHash = semanticHash("");
          monitor.pendingMeaningfulChange = true;
          this.#markMeaningfulActivity(monitor);
          this.#scheduleSettle(monitor, "missing");
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

  #scheduleSettle(monitor, pendingKey) {
    if (monitor.pendingKey === pendingKey && monitor.settleTimer) return;
    clearTimeout(monitor.settleTimer);
    monitor.pendingKey = pendingKey;
    monitor.settleTimer = setTimeout(() => {
      monitor.settleTimer = null;
      void this.#settle(monitor, pendingKey);
    }, monitor.settleMs);
    monitor.settleTimer.unref?.();
  }

  #clearPending(monitor) {
    clearTimeout(monitor.settleTimer);
    monitor.settleTimer = null;
    monitor.pendingKey = null;
    monitor.pendingMeaningfulChange = false;
  }

  async #settle(monitor, expectedKey) {
    if (monitor.status !== "active" || monitor.pendingKey !== expectedKey) return;
    monitor.settling = true;
    try {
      let metadata;
      try {
        metadata = await probeMetadata(monitor.path);
      } catch (error) {
        if (error.code === "TARGET_NOT_FOUND") {
          if (expectedKey !== "missing") {
            this.#scheduleSettle(monitor, "missing");
            return;
          }
          const current = { text: "", metadata: null };
          monitor.observedSnapshot = current;
          monitor.observedSemanticHash = semanticHash("");
          monitor.revisionSnapshot = current;
          monitor.revisionSemanticHash = semanticHash("");
          monitor.revision += 1;
          this.#storeRevisionSnapshot(monitor, monitor.revision, current);
          this.#clearPending(monitor);
          this.#emit(monitor, {
            type: "deleted",
            monitorId: monitor.id,
            path: monitor.path,
            revision: monitor.revision,
            observedAt: new Date(this.now()).toISOString(),
            metadata: null,
          });
          this.#stop(monitor, "target-deleted", "stopped");
          return;
        }
        throw error;
      }

      const current = await readStablePath(monitor.path, READ_RETRY_DELAY_MS);
      const currentHash = semanticHash(current.text);
      const currentKey = `present:${currentHash}`;
      const previousObservedHash = monitor.observedSemanticHash;
      monitor.observedSnapshot = current;
      monitor.observedSemanticHash = currentHash;
      if (currentKey !== expectedKey) {
        if (currentHash !== previousObservedHash) this.#markMeaningfulActivity(monitor);
        monitor.pendingMeaningfulChange = true;
        this.#scheduleSettle(monitor, currentKey);
        return;
      }

      if (currentHash === monitor.revisionSemanticHash) {
        this.#clearPending(monitor);
        this.#resolveAvailableEventWaiters(monitor);
        return;
      }

      const replaced =
        identitySignature(monitor.revisionSnapshot.metadata) !== identitySignature(current.metadata);
      monitor.revisionSnapshot = current;
      monitor.revisionSemanticHash = currentHash;
      monitor.revision += 1;
      this.#storeRevisionSnapshot(monitor, monitor.revision, current);
      this.#clearPending(monitor);
      this.#emit(monitor, {
        type: replaced ? "replaced" : "changed",
        monitorId: monitor.id,
        path: monitor.path,
        revision: monitor.revision,
        observedAt: new Date(this.now()).toISOString(),
        metadata: publicMetadata(current.metadata),
      });
    } catch (error) {
      if (error.code === "TARGET_CHANGED_DURING_READ") {
        this.#scheduleSettle(monitor, monitor.pendingKey ?? expectedKey);
        return;
      }
      this.#fail(monitor, error);
    } finally {
      monitor.settling = false;
    }
  }

  #storeRevisionSnapshot(monitor, revision, snapshot) {
    monitor.revisionSnapshots.set(revision, snapshot);
    while (monitor.revisionSnapshots.size > MAX_EVENT_HISTORY + 2) {
      const removable = [...monitor.revisionSnapshots.keys()].find(
        (candidate) =>
          candidate !== monitor.analysisBaselineRevision && candidate !== monitor.revision,
      );
      if (removable === undefined) break;
      monitor.revisionSnapshots.delete(removable);
    }
  }

  #emit(monitor, event) {
    monitor.lastEventAt = event.observedAt;
    monitor.events.push(event);
    if (monitor.events.length > MAX_EVENT_HISTORY) monitor.events.shift();
    for (const waiter of [...monitor.waiters]) {
      if (event.revision > waiter.afterRevision) {
        waiter.resolve(this.#eventResult(monitor, event, waiter.afterRevision));
      }
    }
  }

  #resolveAvailableEventWaiters(monitor) {
    if (monitor.pendingMeaningfulChange) return;
    for (const waiter of [...monitor.waiters]) {
      let event;
      for (let index = monitor.events.length - 1; index >= 0; index -= 1) {
        if (monitor.events[index].revision > waiter.afterRevision) {
          event = monitor.events[index];
          break;
        }
      }
      if (event) waiter.resolve(this.#eventResult(monitor, event, waiter.afterRevision));
    }
  }

  #markMeaningfulActivity(monitor) {
    monitor.lastMeaningfulActivityAtMs = this.now();
    monitor.idleWarningIssued = false;
    monitor.idleWarningPending = false;
    monitor.idleWarningDelivered = false;
    this.#scheduleIdleTimer(monitor);
  }

  #scheduleIdleTimer(monitor) {
    clearTimeout(monitor.idleTimer);
    if (monitor.status !== "active") return;
    const elapsed = Math.max(0, this.now() - monitor.lastMeaningfulActivityAtMs);
    const threshold = monitor.idleWarningIssued ? this.idleStopMs : this.idleWarningMs;
    const delay = Math.max(1, threshold - elapsed);
    monitor.idleTimer = setTimeout(() => this.#handleIdleTimer(monitor), delay);
    monitor.idleTimer.unref?.();
  }

  #handleIdleTimer(monitor) {
    if (monitor.status !== "active") return;
    const elapsed = Math.max(0, this.now() - monitor.lastMeaningfulActivityAtMs);
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
      this.#stop(monitor, "idle-timeout", "stopped");
      return;
    }
    this.#scheduleIdleTimer(monitor);
  }

  #idleWarningResult(monitor) {
    const idleForMs = Math.max(0, this.now() - monitor.lastMeaningfulActivityAtMs);
    return {
      state: "idle-warning",
      monitorId: monitor.id,
      revision: monitor.revision,
      status: monitor.status,
      idleForMs,
      stopInMs: Math.max(0, this.idleStopMs - idleForMs),
      message: IDLE_WARNING_MESSAGE,
    };
  }

  #fail(monitor, error) {
    const normalized = translateFileError(error, monitor.path);
    monitor.error = { code: normalized.code, message: normalized.message, details: normalized.details };
    this.#stop(monitor, "runtime-failed", "error");
  }

  #stop(monitor, reason, status, resolveWaiters = true) {
    clearInterval(monitor.pollTimer);
    clearTimeout(monitor.settleTimer);
    clearTimeout(monitor.idleTimer);
    monitor.pollTimer = null;
    monitor.settleTimer = null;
    monitor.idleTimer = null;
    monitor.pendingKey = null;
    monitor.pendingMeaningfulChange = false;
    monitor.status = status;
    monitor.reason = reason;
    if (this.activeByPath.get(monitor.path) === monitor.id) this.activeByPath.delete(monitor.path);
    if (!resolveWaiters) return;
    const result = {
      state:
        status === "error" ? "error" : reason === "idle-timeout" ? "idle-stopped" : "stopped",
      ...this.#status(monitor),
    };
    for (const waiter of [...monitor.waiters]) waiter.resolve(result);
  }
}

function toolSuccess(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolFailure(error) {
  const normalized =
    error instanceof HoonsooError
      ? error
      : new HoonsooError("INTERNAL_ERROR", error?.message ?? String(error));
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
      case "read_snapshot":
        result = session.readSnapshot(args);
        break;
      case "wait_for_change":
        result = await session.waitForChange(args, signal);
        break;
      case "get_status":
        result = session.getStatus(args);
        break;
      case "stop_monitor":
        result = session.stopMonitor(args);
        break;
      default:
        throw new HoonsooError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
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
                "Hoonsoo only reads explicitly selected UTF-8 regular files. It never writes to the target or workspace.",
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
