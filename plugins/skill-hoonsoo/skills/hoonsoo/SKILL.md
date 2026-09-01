---
name: hoonsoo
description: Monitor one local text document after disk-backed saves and provide combined content and grammar feedback without editing files. Use when the user invokes $hoonsoo, /skill-hoonsoo:hoonsoo, or unambiguously asks for ongoing Hoonsoo review; do not use for one-shot rewrites, automatic fixes, or file modification.
---

# Hoonsoo

Monitor one local document and give read-only content and grammar advice for its baseline and every saved revision. Optimize for save-to-feedback latency: use the current host model for one combined review pass over one MCP-provided context bundle.

## Safety boundary

- Give advice only. Never edit, patch, overwrite, format, rename, create, or delete the target or another workspace file.
- The runtime may mutate only isolated process memory. It must not persist snapshots, diffs, or feedback in the workspace.
- Never run a mutating formatter, compiler, or shell command during monitoring.
- If the user asks to apply a fix, stop Hoonsoo and handle editing as a separate task.

## Invocation

Support both host-native forms:

```text
$hoonsoo <filepath> <prompt>
/skill-hoonsoo:hoonsoo <filepath> <prompt>
```

The first argument is the target path; the remaining text is an optional review focus. Quote paths containing spaces. Resolve exactly one absolute target. At startup, state the absolute path briefly and say that “훈수중지”, “stop Hoonsoo”, or equivalent language stops monitoring.

Every review combines:

- content: meaning, completeness, consistency, clarity, risk, missing assumptions, and actionability;
- grammar: file syntax, natural-language grammar, spelling, punctuation, style, terminology, whitespace, and formatting.

Do not expose separate context and grammar modes. The optional prompt adds priorities but never disables either review dimension.

## Save semantics

React only to a new state persisted to disk. Size alone is insufficient; the deterministic runtime combines metadata with a raw-content hash, so same-size replacements and atomic saves remain detectable.

The operating system cannot reliably distinguish manual save from autosave. Both count as disk-backed saves. A metadata-only save with the same raw-content hash creates neither a revision nor a model review. Whitespace-only changes are valid because grammar and formatting are in scope.

There is no debounce, throttling, or quiet window. The runtime may retry a read that overlaps an in-progress write only to obtain a consistent snapshot.

## Performance contract

- Never spawn or delegate to a subagent for a Hoonsoo review. MCP session memory is process-local and is not a cross-agent message bus.
- The current host model performs field inference, content review, and grammar review together in one pass per published revision.
- Use the complete bundle returned by `read_review_context`; do not reread the target, repeat status checks, page through artifacts, or perform a second review.
- Do not say that a specialist agent cannot share memory, that a fallback model is being used, or otherwise narrate internal routing.
- Prefer one sufficiently complete review input over many small tool calls. This intentionally spends somewhat more input tokens to reduce latency.
- Keep monitoring, stable reads, hashes, diffs, revision ordering, compare-and-set validation, and idle timers deterministic and model-free.

## Runtime tools

The Hoonsoo MCP exposes exactly this fast-path surface:

- `start_monitor`: start or reuse one target monitor and capture internal revision zero.
- `read_review_context`: return prompt, bounded current context, current revision or aggregate diff, relevant prior feedback, and a short-lived review token in one call.
- `publish_feedback`: atomically validate the review token, revision, and content hash, store the feedback in session memory, and mark it published.
- `wait_for_save`: wait locally for a saved revision or lifecycle event.
- `get_status`: use only for cancellation, error diagnosis, or recovery; it is not part of the normal review path.
- `stop_monitor`: stop the monitor and release timers and session memory.

If these tools are unavailable, report that the plugin must be installed or reloaded. Do not simulate monitoring with repeated shell or filesystem calls.

## Baseline workflow

1. Call `start_monitor` with the absolute path and invocation prompt.
2. Call `read_review_context` for the returned monitor. This starts an analysis lease, which pauses idle warning and shutdown while review is in progress.
3. Using only that bundle, perform one direct, combined content-and-grammar review with the current host model.
4. Call `publish_feedback` with the exact `reviewToken`, `revision`, `contentHash`, and natural-language feedback. This compare-and-set operation rejects obsolete work and restarts the idle clock at publication.
5. If publication succeeds, show the exact feedback using the output format below.
6. Call `wait_for_save` with `afterRevision` equal to the last published revision and `timeoutMs: 45000`.

The 45-second wait stays below the normal 60-second MCP tool timeout. A plain timeout produces no user-visible message; immediately call the same wait again. This small tool-call cost is intentional and prevents a host timeout from breaking the monitor.

## Saved-revision loop

For every saved revision event:

1. Call `read_review_context` for the newest revision. The bundle contains either its aggregate changed ranges or, when rebaselining is required, bounded current-document context.
2. Perform exactly one direct combined review.
3. Call `publish_feedback` with the exact token, revision, and hash.
4. On success, display the numbered feedback and wait again with `timeoutMs: 45000`.

If `publish_feedback` rejects a stale token because a newer save arrived, do not display or merge the obsolete result. Immediately call `read_review_context` for the newest revision and review that bundle. Do not call `get_status` merely to preflight a publish; the publish operation is the authoritative gate.

## Analysis lease and idle lifecycle

Reading review context issues an internal lease. While the lease is active, idle warning and automatic stop are paused. A successful publish ends the lease and starts a fresh idle period. If a review is abandoned, the bounded lease expires and the idle clock starts then, so the monitor cannot remain alive forever.

While waiting after publication:

- After 60 seconds without a raw-content-changing save, output this notice exactly once:

  ```text
  {n} 번째 훈수 :
  1분 간, 작업이 감지되지 않습니다. 추가 30초 대기 후, 훈수모드가 정지됩니다.
  추후 다시 훈수모드를 켜시려면 스킬을 다시 실행해주세요.
  ```

- After another 30 seconds without a changed save, end the run.
- If the target is deleted or unreadable, report it once and stop.
- On explicit cancellation, call `stop_monitor` before responding.
- On an unrelated user interruption, inspect the request before deciding whether to stop.

Waiting happens inside the local runtime. Never create visible heartbeat messages for the 45-second diagnostic timeout.

## Natural-language output

Maintain a one-based batch counter. For feedback, use only:

```text
{n} 번째 훈수 :

현재 저장본에서 확인한 내용과 문법상의 문제를 사람이 설명하듯 자연스럽게 서술합니다. 왜 중요한지와 사용자가 취할 수 있는 구체적인 조치를 함께 담습니다.
```

Do not display `revision:` or any internal revision, token, hash, artifact, model, routing, or key-value field. Do not expose `anchor:`, `category:`, `severity:`, `message:`, `rationale:`, `suggestedAction:`, or `confidence:`. Multiple findings may use readable paragraphs or a short numbered list. If nothing is actionable, say so briefly.

## Optional context

Hoonsoo needs no plugin beyond its own MCP. If grounded advice genuinely needs external context, use an already connected read-only source or recommend it once: GitHub or GitLab for repository context, Atlassian Rovo for issues and wiki material, Figma for screen specifications, Google Drive, Dropbox, or Box for related documents, and authoritative official documentation for current APIs. Never install or connect another plugin automatically.

## Stop conditions

Stop on explicit cancellation, target deletion or unreadability, runtime failure, session end, or the idle stop. On a controllable stop, call `stop_monitor`. A later run must invoke Hoonsoo again.
