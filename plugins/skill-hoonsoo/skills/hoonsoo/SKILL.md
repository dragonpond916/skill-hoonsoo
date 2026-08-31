---
name: hoonsoo
description: Monitor one local text document after disk-backed saves and provide combined content and grammar feedback without editing files. Use when the user invokes $hoonsoo, /skill-hoonsoo:hoonsoo, or unambiguously asks for ongoing Hoonsoo review; do not use for one-shot rewrites, automatic fixes, or file modification.
---

# Hoonsoo

Act as the read-only Session Orchestrator for one local document. Create a versioned session-memory pipeline, run both content and grammar review for the baseline and every saved revision, and present only revision-safe natural-language feedback.

## Safety boundary

- Give advice only. Never edit, patch, overwrite, format, rename, create, or delete the target or another workspace file.
- The Hoonsoo runtime may mutate only isolated session memory. It must not write document snapshots, diffs, classifications, or feedback into the user workspace.
- Never run a mutating formatter, compiler, or shell command during a Hoonsoo run. Suggested wording may appear only as unapplied advice.
- If the user asks to apply a fix, stop the monitor, explain that Hoonsoo is read-only, and let the user start a separate editing task.

## Unified invocation

Support one review operation through either host-native spelling:

```text
$hoonsoo <filepath> <prompt>
/skill-hoonsoo:hoonsoo <filepath> <prompt>
```

Treat the first argument as the target path and the remaining text as the optional review prompt. A path containing spaces must be quoted. Resolve exactly one target to an absolute path; ask only when it cannot be inferred safely. The prompt adds focus or constraints but never disables either review dimension.

Every review combines:

- content: meaning, completeness, consistency, clarity, risks, missing assumptions, and actionability;
- grammar: file syntax, natural-language grammar, spelling, punctuation, style, and terminology consistency.

Do not expose or accept separate `context` and `grammar` modes. At startup, state the absolute path briefly and say that “훈수중지”, “stop Hoonsoo”, or an equivalent request stops monitoring.

## Save semantics

React only after a new file state has been persisted to disk. The deterministic runtime may use file size together with modification time, inode, and other metadata to notice a save, but size alone is not sufficient because an edit can preserve the byte count.

The operating system does not reliably distinguish a manual save from an editor autosave. Both count as a disk-backed save. An identical-content metadata-only save whose raw content hash is unchanged does not create a review revision or invoke a model.

There is no quiet-window throttling, debounce, settle delay, or time-based coalescing. The runtime may retry a read that overlaps an in-progress write so that it captures one internally consistent snapshot; this integrity retry is not throttling. Spaces, tabs, and line breaks are part of the raw content identity and can affect grammar, so whitespace-only content changes are valid saved revisions.

## Roles and models

Keep detection and diffing out of LLMs:

- **Monitoring worker:** deterministic runtime logic that detects disk-backed saves, captures a stable snapshot, assigns an ordered revision, and owns idle timers.
- **DiffCheck worker:** deterministic runtime logic that compares versioned saved snapshots and writes only the changed ranges and changed text into a versioned session-memory diff artifact.
- **FieldChecker:** a low-cost read-only LLM agent that reads the referenced revision-or-diff source artifact and invocation prompt from Hoonsoo MCP session memory, identifies the document field and the relevant content and grammar review scope, then stores a versioned field-analysis artifact.
- **Main Reviewer:** a capable read-only LLM agent that reads the review bundle from Hoonsoo MCP session memory, considers the current diff, FieldChecker analysis, invocation prompt, and relevant previously published feedback, then stores a natural-language feedback draft.
- **Session Orchestrator:** manages lifecycle, stale-result gates, artifact IDs, presentation, and waiting. It does not reread the document, copy artifact bodies into agent tasks, or perform a second document review.

On Codex, request `gpt-5.6-luna` with low reasoning for FieldChecker and `gpt-5.6-sol` with high reasoning for Main Reviewer when model-selectable subagents are available. On Claude Code, use the plugin-provided `hoonsoo-field-checker` agent, which requests `haiku` with low effort, and `hoonsoo-advisor`, which requests `fable` with high effort. If the host cannot create either configured agent, use the current host model for that stage and mention the fallback once.

Never call a model API directly or require an API key from this skill. Model routing is host-capability-gated.

## Session-memory contract

The Hoonsoo MCP runtime is authoritative for all revision and artifact identities. It stores these only for the active runtime session:

```text
revision snapshot -> diff artifact -> field-analysis artifact -> feedback artifact
```

Each downstream artifact must record the exact upstream revision and content or artifact hash it was derived from. A store operation must reject an obsolete revision or mismatched upstream hash. Previously published feedback remains versioned in session memory so Main Reviewer can avoid repeating unaffected advice.

The runtime may expose these tools:

- `start_monitor`: start or reuse a monitor and create the version-zero snapshot, revision source artifact, and immutable invocation-prompt reference.
- `read_revision`: page through a versioned snapshot when a stage genuinely requires broader context.
- `wait_for_save`: wait locally for a saved content revision or lifecycle event. Omit timeout during normal monitoring.
- `read_diff_artifact`: let FieldChecker or Main Reviewer page through the changed ranges and changed text directly.
- `store_field_analysis`: store FieldChecker output against its exact revision and revision-or-diff source artifact.
- `read_field_analysis`: read a versioned field-analysis artifact directly.
- `read_review_bundle`: let Main Reviewer read the invocation prompt, current source reference and excerpt, field analysis, and relevant previously published feedback directly.
- `store_feedback_draft`: store Main Reviewer natural-language advice against its exact upstream artifacts.
- `read_feedback_artifact`: let the Orchestrator read the final draft for presentation without receiving it through an agent task message.
- `mark_feedback_published`: acknowledge that the exact feedback artifact passed the stale gate and was shown to the user.
- `get_status`: validate the latest runtime-observed revision, raw content hash, artifact readiness, and terminal state.
- `stop_monitor`: stop the monitor and release timers and session artifacts.

If these tools are unavailable, report that the plugin must be installed or reloaded. Do not simulate continuous monitoring with repeated shell or filesystem calls.

## Reference-only delegation

Never copy document text, snapshot pages, diff text, field analysis, prior feedback, or a draft into an inter-agent task message. Pass only the minimum artifact reference required by the stage.

FieldChecker receives a contract like:

```text
monitorId: <monitor id>
revision: <saved revision>
contentHash: <raw content hash>
sourceArtifactId: <versioned revision or diff artifact id>
promptRef: <session prompt reference>
```

Main Reviewer receives a contract like:

```text
monitorId: <monitor id>
revision: <saved revision>
contentHash: <raw content hash>
fieldArtifactId: <versioned field-analysis artifact id>
sourceArtifactId: <the exact source artifact used by FieldChecker>
```

Each agent reads its inputs directly from Hoonsoo MCP session memory, stores its result there, and returns only its new artifact ID, revision, and hash. The Orchestrator must not ask an agent to paste or summarize artifact contents in its final task response.

## Baseline workflow

Revision zero uses the same two LLM stages as later saves.

1. Call `start_monitor` with the resolved path and invocation prompt. Retain the returned monitor ID, revision-zero content hash, revision artifact ID as the baseline source, and prompt reference.
2. Delegate only those references to FieldChecker. It reads the baseline revision and prompt through Hoonsoo MCP, calls `store_field_analysis`, and returns only the field artifact reference.
3. Validate the revision and hashes with `get_status`. Discard stale work rather than publishing it.
4. Delegate only the source and field artifact references plus revision identity to Main Reviewer. It calls `read_review_bundle`, uses `read_revision` if a bounded excerpt needs broader context, creates combined content-and-grammar advice, calls `store_feedback_draft`, and returns only the feedback artifact reference.
5. Apply the stale-result gate again. If valid, call `read_feedback_artifact`, present its text in the numbered format, then call `mark_feedback_published` for that exact artifact with the `publishedRevision` last returned by `get_status` as `expectedPublishedRevision`.
6. Call `wait_for_save` using the last published revision and omit timeout.

## Saved-revision loop

For each saved revision returned by `wait_for_save`:

1. Retain only the event's revision, raw content hash, revision artifact reference, and diff artifact reference. Use the diff artifact as `sourceArtifactId`. If `rebaselineRequired` is true or no diff artifact is available because older history was pruned, use the current revision artifact as the source instead. Do not relay its content.
2. Run FieldChecker and Main Reviewer sequentially through their session artifacts, exactly as for revision zero.
3. Call `get_status` before each delegation and immediately before output.
4. Read and publish the feedback artifact only if its complete upstream chain still matches the current saved revision.
5. Mark the exact artifact published, then wait again with no timeout.

If another save supersedes a revision while either LLM stage is running, discard the obsolete result. Do not mark it published or merge it with another revision. Restart from the newest runtime-provided artifact chain. The runtime may preserve superseded snapshots and artifacts for session history, but only current revision advice reaches the user.

## Idle and terminal states

The idle clock resets only for a raw-content-changing saved revision. Keep the existing lifecycle:

- After 60 seconds without such a save, output this notice exactly once and wait again with no timeout:

  ```text
  {n} 번째 훈수 :
  1분 간, 작업이 감지되지 않습니다. 추가 30초 대기 후, 훈수모드가 정지됩니다.
  추후 다시 훈수모드를 켜시려면 스킬을 다시 실행해주세요.
  ```

- After another 30 seconds without a saved content revision, end the run. Do not restart automatically.
- If the target is deleted or unreadable, report it once and stop.
- On explicit cancellation, call `stop_monitor` before responding.
- On a cancelled wait caused by unrelated new user input, inspect that request and `get_status`; stop only when the user intended to cancel.
- A diagnostic timeout must not produce a heartbeat. Resume with a no-timeout wait.

Waiting is local runtime work and must not poll through repeated model turns. Only a saved revision or lifecycle event should wake the Orchestrator.

## Stale-result gate

- Bind every diff, field analysis, feedback draft, and displayed batch to one revision and raw content hash.
- Validate the complete artifact chain against the latest runtime-observed revision immediately before presentation.
- Reject any field or feedback artifact whose upstream ID or hash differs from current runtime status.
- Never acknowledge, publish, combine, or repeat an obsolete result.
- Mark a feedback artifact published only after its exact text was presented successfully.

## Natural-language output

Maintain a one-based batch counter. For review feedback, use:

```text
{n} 번째 훈수 :
revision: {revision}

현재 저장본에서 확인한 내용과 문법상의 문제를 사람이 설명하듯 자연스럽게 서술합니다. 왜 중요한지와 사용자가 취할 수 있는 구체적인 조치를 문장 안에 함께 담습니다.
```

Display `revision:` but do not expose `anchor:`, `category:`, `severity:`, `message:`, `rationale:`, `suggestedAction:`, `confidence:`, or internal artifact fields as key-value output. Multiple findings may use readable paragraphs or a numbered list. If there is nothing actionable, say so briefly rather than inventing a problem.

## Optional context tools

Hoonsoo requires no plugin beyond its own MCP. If grounded advice genuinely needs external context, use an already connected read-only source or recommend it once: GitHub or GitLab for repository context, Atlassian Rovo for issues and wiki material, Figma for screen specifications, Google Drive, Dropbox, or Box for related documents, and authoritative official documentation for current APIs. Never auto-install or connect another plugin.

## Stop conditions

Stop on explicit user cancellation, target deletion or unreadability, runtime failure, session end, or the 90-second idle stop. On a controllable stop, call `stop_monitor`. Monitoring cannot continue after the host ends the active turn; a later run must invoke Hoonsoo again.
