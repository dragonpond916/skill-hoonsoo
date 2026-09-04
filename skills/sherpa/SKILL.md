---
name: sherpa
description: Monitor one local text document after disk-backed saves and provide combined content and grammar feedback without editing files. Use when the user invokes $sherpa, /skill-sherpa:sherpa, or unambiguously asks for ongoing Sherpa review; do not use for one-shot rewrites, automatic fixes, or file modification.
---

# Sherpa

Monitor one local document and give read-only content and grammar advice for its baseline and every saved revision. Optimize for save-to-feedback latency: use the current host model for one combined review pass over the single `reviewContext` supplied by the monitoring call.

## Safety boundary

- Give advice only. Never edit, patch, overwrite, format, rename, create, or delete the target or another workspace file.
- The runtime may mutate only isolated process memory. It must not persist snapshots, diffs, or feedback in the workspace.
- Never run a mutating formatter, compiler, or shell command during monitoring.
- If the user asks to apply a fix, stop Sherpa and handle editing as a separate task.

## Invocation

Support both host-native forms:

```text
$sherpa <filepath> <prompt>
/skill-sherpa:sherpa <filepath> <prompt>
```

The first argument is the target path; the remaining text is an optional review focus. Quote paths containing spaces. Resolve exactly one absolute target. At startup, state the absolute path briefly and say that “세르파 중지”, “stop Sherpa”, or equivalent language stops monitoring.

Every review combines:

- content: meaning, completeness, consistency, clarity, risk, missing assumptions, and actionability;
- grammar: file syntax, natural-language grammar, spelling, punctuation, style, terminology, whitespace, and formatting.

Do not expose separate content and grammar modes. The optional prompt adds priorities but never disables either review dimension.

## Save semantics

React only to a new state persisted to disk. The deterministic runtime probes metadata every 25 ms, then validates the raw-content hash. Same-size replacements and atomic saves remain detectable.

The operating system cannot reliably distinguish manual save from autosave. Both count as disk-backed saves. Autosave can shorten the delay from typing to review, but an unsaved editor buffer is invisible to Sherpa. A metadata-only save with the same raw-content hash creates neither a revision nor a model review. Whitespace-only changes are valid because grammar and formatting are in scope.

There is no debounce, throttling, or quiet window. The runtime may retry a read that overlaps an in-progress write only to obtain a consistent snapshot.

## Performance contract

- Never spawn or delegate to a subagent for a Sherpa review. MCP session memory is process-local and is not a cross-agent message bus.
- The current host model performs field inference, content review, and grammar review together in one pass per published revision.
- `start_monitor` embeds the baseline `reviewContext`; `wait_for_save` embeds the newest saved-revision `reviewContext`.
- The baseline context contains one bounded document input. A saved-revision context contains only the aggregate changed diff; do not request or reread the full document.
- Do not call `read_review_context` in the normal path. It exists only for compatibility, diagnosis, or recovery when an embedded context is missing or invalid.
- Using only the embedded context, produce one to three concise natural-language findings. In the same assistant phase, show those findings and call `publish_feedback` with the returned identity and compare-and-set fields. Omit the feedback body unless the runtime explicitly requires it.
- Do not repeat status checks, page through artifacts, reread the target, or perform a second review.
- Keep monitoring, stable reads, hashes, diffs, revision ordering, compare-and-set validation, and idle timers deterministic and model-free.

## Codex latency setup

For the lowest interactive latency, recommend a dedicated Codex task using `gpt-5.6-luna`, low reasoning effort, and `/fast on`. Make this recommendation once, not after every save. The plugin cannot select or change the host task's model, reasoning effort, or fast-mode setting; the user must configure them in Codex.

## Runtime tools

The Sherpa MCP exposes exactly six tools:

- `start_monitor`: start or reuse one target monitor, capture internal revision zero, and return its embedded baseline `reviewContext`.
- `wait_for_save`: wait locally for a saved revision or lifecycle event and return a diff-only `reviewContext` with a changed revision.
- `publish_feedback`: validate the identifiers from `reviewContext`, mark that review published, and restart the idle clock. The natural-language feedback body is optional.
- `read_review_context`: compatibility and recovery access when a normal monitoring response lacks a usable embedded context.
- `get_status`: cancellation, error diagnosis, and recovery only.
- `stop_monitor`: stop the monitor and release timers and session memory.

If these tools are unavailable, report that the plugin must be installed or reloaded. Do not simulate monitoring with repeated shell or filesystem calls.

## Baseline workflow

1. Call `start_monitor` with the absolute path and invocation prompt.
2. Review only its embedded `reviewContext`, which contains one bounded document input and an analysis lease.
3. In one assistant phase, output one to three concise findings in the format below and call `publish_feedback` using the exact `monitorId`, `reviewToken`, `revision`, and `contentHash`. Include `feedback` only when required by the tool schema.
4. After publication, call `wait_for_save` with `afterRevision` equal to the last published revision and `timeoutMs: 45000`.

The 45-second wait stays below the normal 60-second MCP tool timeout. A plain timeout produces no user-visible message; immediately call the same wait again.

## Saved-revision loop

For every saved revision event:

1. Review only the diff-only `reviewContext` embedded by `wait_for_save`. Do not call `read_review_context`.
2. In one assistant phase, output one to three concise findings and call `publish_feedback` with the exact returned identity fields; the feedback body is optional.
3. On success, resume `wait_for_save` with `timeoutMs: 45000` without an extra status call or user-visible progress message.

If publication reports stale context because a newer save arrived, immediately call `wait_for_save` with `afterRevision` equal to the obsolete revision and `timeoutMs: 0`, then review its newest embedded context. Use `read_review_context` only when recovery is impossible from an embedded context, and never call `get_status` merely to preflight publication.

## Analysis lease and idle lifecycle

Returning an embedded review context issues an internal analysis lease. While the lease is active, idle warning and automatic stop are paused. A successful publication ends the lease and starts a fresh idle period. If a review is abandoned, the bounded lease expires and the idle clock starts then.

While waiting after publication:

- After 60 seconds without a raw-content-changing save, output this notice exactly once:

  ```text
  세르파의 {n}번째 조언 :
  1분간 작업이 감지되지 않았습니다. 30초 더 기다린 후 세르파 모드가 정지됩니다.
  나중에 다시 시작하려면 $sherpa를 호출해주세요.
  ```

- After another 30 seconds without a changed save, end the run.
- If the target is deleted or unreadable, report it once and stop.
- On explicit cancellation, call `stop_monitor` before responding.
- On an unrelated user interruption, inspect the request before deciding whether to stop.

Waiting happens inside the local runtime. Never create visible heartbeat messages for the 45-second diagnostic timeout.

## Natural-language output

Maintain a one-based batch counter. Each review contains at most three concise findings and uses only:

```text
세르파의 {n}번째 조언 :

현재 저장본에서 확인한 내용과 문법상의 문제를 사람이 설명하듯 자연스럽게 서술합니다. 왜 중요한지와 사용자가 취할 수 있는 구체적인 조치를 함께 담습니다.
```

Do not display `revision:` or any internal revision, token, hash, artifact, model, routing, or key-value field. Do not expose `anchor:`, `category:`, `severity:`, `message:`, `rationale:`, `suggestedAction:`, or `confidence:`. If nothing is actionable, say so in one short sentence.

## Optional context

Sherpa needs no plugin beyond its own MCP. If grounded advice genuinely needs external context, use an already connected read-only source or recommend it once: GitHub or GitLab for repository context, Atlassian Rovo for issues and wiki material, Figma for screen specifications, Google Drive, Dropbox, or Box for related documents, and authoritative official documentation for current APIs. Never install or connect another plugin automatically.

## Stop conditions

Stop on explicit cancellation, target deletion or unreadability, runtime failure, session end, or the 90-second idle stop. On a controllable stop, call `stop_monitor`. A later run must invoke Sherpa again.
