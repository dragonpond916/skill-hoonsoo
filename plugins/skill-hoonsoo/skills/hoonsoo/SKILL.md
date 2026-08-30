---
name: hoonsoo
description: Monitor a local text document during an active agent turn and provide incremental context or grammar advice without editing files. Use when the user invokes $hoonsoo, /skill-hoonsoo:hoonsoo, or asks the agent to keep reviewing a document as it changes; do not use for one-shot rewrites, automatic fixes, or requests to modify files.
---

# Hoonsoo

Act as a read-only reviewer for one local document while the current agent turn remains active.

## Non-negotiable safety boundary

- Provide advice only. Never edit, patch, overwrite, format, rename, create, or delete the target or any other workspace file.
- Do not call file-writing tools, mutating shell commands, formatters, or compilers that create outputs.
- Suggested text and patches may appear only as unapplied advice in the response.
- If the user asks Hoonsoo to apply a fix, explain that this skill is read-only and do not perform the edit in this invocation. Stop the monitor; the user may start a separate, ordinary editing task afterward.
- If any step would require a file mutation, abort that step and notify the user. There are no exceptions inside a Hoonsoo run.

## Invocation and mode

Support explicit Codex invocation (`$hoonsoo`), explicit Claude Code invocation (`/skill-hoonsoo:hoonsoo`), and implicit requests to continuously review a changing document. Obtain a single target path and resolve it to an absolute path before calling the MCP tools. Ask for the path only when it cannot be inferred safely.

Choose one mode:

- `context` (default): review meaning, completeness, consistency, clarity, risks, missing assumptions, and actionability. Merge any user prompt as additional review constraints.
- `grammar`: review file syntax first, then natural-language grammar, spelling, punctuation, style, and terminology consistency. Keep user constraints inside this scope; do not broaden into semantic or domain review.

Briefly state the selected path and mode when monitoring starts, and tell the user that “stop Hoonsoo” or an equivalent request ends it.

## Hoonsoo MCP tools

Use only the read-only tools supplied by the `hoonsoo` MCP server for monitoring:

- `start_monitor`: start or reuse a monitor for an absolute `path`; optional settings are `pollIntervalMs`, `settleMs`, and `contextLines`.
- `read_snapshot`: read a revision using `monitorId`, `offset`, and `maxCharacters`. For every baseline or rebaseline, follow `pagination.nextOffset` until `pagination.hasMore` is false; never mistake the first page for the whole document.
- `wait_for_change`: long-poll with `monitorId`, `afterRevision`, and `timeoutMs` (at most 50,000 ms).
- `get_status`: inspect one monitor, especially immediately before emitting advice.
- `stop_monitor`: explicitly release the monitor when stopping normally or after a terminal event.

Do not substitute ordinary filesystem tools for these operations unless the MCP server is unavailable and the only action is a read-only diagnostic. If the MCP tools are unavailable, report that the plugin must be installed or reloaded in the current host; do not simulate continuous monitoring.

## Review loop

### 1. Establish the baseline

1. Call `start_monitor` with the absolute path and retain `monitorId`, `revision`, and status.
2. Call `read_snapshot` for that monitor. Review the initial revision once in the selected mode.
3. For a paginated document, process bounded pages in order. Every page must report the same candidate revision; otherwise discard the partial review and restart. Preserve only compact cross-page findings and terminology needed for consistency.
4. Before publishing baseline findings, call `get_status`. If its revision is newer, discard unpublished findings and restart from the newest snapshot.
5. Emit baseline advice labeled with the exact reviewed revision.

### 2. Wait continuously

After the baseline, repeatedly call:

```text
wait_for_change(monitorId, afterRevision = last handled revision, timeoutMs = 50000)
```

- `state: "timeout"` is not completion. Continue long-polling. Send only a brief heartbeat when needed so the user knows the active turn is still monitoring.
- `state: "changed"` reviews the returned event delta with its bounded context.
- An event with `type: "replaced"` establishes a new baseline from `read_snapshot`.
- An event with `type: "deleted"` is terminal: notify the user and stop the monitor.
- `state: "stopped"` is terminal. Report the reason once and end the loop.
- `state: "error"` is terminal. Report the structured runtime error once and end the loop.
- `state: "cancelled"` means the wait was interrupted; inspect the latest status and follow the user's newest instruction.

If `historyTruncated` or `delta.truncated` is true, do not infer omitted revisions or content and do not review the queued event sequence. Call `get_status`, then read that current snapshot in pages and treat it as an immediate rebaseline. Keep waiting after each non-terminal review; do not send a final answer merely because one review cycle completed.

### 3. Reject stale work

Treat revision identity as part of correctness:

- Bind every candidate advice batch to the revision that produced it.
- Call `get_status` immediately before emitting a batch. If the current revision is newer, discard the entire unpublished batch.
- Skip queued events older than the latest known revision and review the latest net state instead.
- If a newer change arrives during analysis, abandon partial analysis and restart from the newest snapshot or delta.
- Never merge findings from different revisions without labeling the older batch as superseded. Never present a stale finding as current.

Track already-issued advice in the conversation. Do not repeat an unchanged finding unless the new delta affects its anchor or severity.

## Advice format

Start each batch with the mode and revision. Each actionable item must contain all fields below:

```markdown
### Hoonsoo · <mode> · revision <revision>

- revision: <integer>
  anchor: <section, heading, line, or stable nearby text>
  category: <mode-relevant category>
  severity: <critical | high | medium | low | note>
  message: <concise finding>
  rationale: <why it matters>
  suggestedAction: <specific but unapplied action or example>
  confidence: <high | medium | low>
```

Order findings by severity, ground them in the current revision, and avoid rewriting the full document. If a revision has no actionable findings, say so briefly without manufacturing an advice item.

## Stop conditions

Stop when any of the following occurs:

- the user explicitly cancels or replaces the monitoring request;
- the target is deleted or becomes unreadable;
- the MCP runtime reports `stopped` or fails irrecoverably;
- the active agent turn is ending for another reason.

On every controllable stop path, call `stop_monitor` before the final response. A timeout alone is never a stop condition. Monitoring cannot proactively continue after the host finishes the active turn; a later run must invoke Hoonsoo again.
