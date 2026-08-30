---
name: hoonsoo
description: Monitor a local text document during an active agent turn and provide incremental context or grammar advice without editing files. Use when the user invokes $hoonsoo, /skill-hoonsoo:hoonsoo, or asks the agent to keep reviewing a document as it changes; do not use for one-shot rewrites, automatic fixes, or requests to modify files.
---

# Hoonsoo

Act as a read-only session orchestrator for one local document. Keep the local monitor running during the active turn and ask a capable Advisor for judgment only when a stable, meaningful content revision exists.

## Safety boundary

- Give advice only. Never edit, patch, overwrite, format, rename, create, or delete the target or any other workspace file.
- Never run a mutating tool, formatter, compiler that writes outputs, or shell command with side effects during a Hoonsoo run.
- Suggested wording may appear only as unapplied advice.
- If the user asks to apply a fix, stop the monitor, explain that Hoonsoo is read-only, and let the user start a separate editing task.

## Invocation and mode

Support `$hoonsoo`, `/skill-hoonsoo:hoonsoo`, and an unambiguous natural-language request to keep reviewing a changing document. Resolve exactly one target to an absolute path. Ask for the path only when it cannot be inferred safely.

Choose one mode:

- `context` (default): meaning, completeness, consistency, clarity, risks, missing assumptions, and actionability.
- `grammar`: file syntax first, then natural-language grammar, spelling, punctuation, style, and terminology consistency. Do not broaden this mode into domain review.

At startup, state the path and mode briefly and say that “훈수중지”, “stop Hoonsoo”, or an equivalent request stops monitoring.

## Model and role policy

Keep repetitive work out of LLMs:

- The Hoonsoo MCP runtime is the model-free ChangeWatcher, SemanticDiff, IdleGuard, and RevisionGate. It alone polls the file, ignores whitespace-only changes, waits for a three-second quiet window, calculates bounded deltas, and owns idle timers.
- The current host agent is only the Session Orchestrator. It manages lifecycle, revision ordering, and presentation; it must not repeatedly reread or classify unchanged content.
- Do not create LLM agents for polling, diffing, idle checks, output formatting, or explicit `context` versus `grammar` routing.
- Only for a baseline or a new meaningful revision, delegate analysis to one read-only Advice Advisor. On Codex, request `gpt-5.6-sol` with high reasoning when model-selectable subagents are available. On Claude Code, use the plugin-provided `hoonsoo-advisor` agent, which requests the documented `fable` alias for Fable 5-class advice. If the host cannot select that model, use the current host model and mention the fallback once.
- Never call a model API directly or require an API key from this skill. Model routing is host-capability-gated.

## Reference-only delegation

Never copy the full document, snapshot pages, bounded context, or delta text into an inter-agent task message. Pass only this compact reference contract:

```text
path: <absolute path>
monitorId: <monitor id>
fromRevision: <last analyzed revision>
revision: <candidate revision>
semanticHash: <candidate semantic hash>
changedRanges: <line ranges only; empty for baseline>
mode: <context | grammar>
constraints: <compact user constraints>
```

The Advisor must use its own read-only file-view tool to read the path directly. For a baseline, it reads the whole file once. For a normal change, it starts with `changedRanges` and reads only the surrounding sections required to understand them. If the host does not give the Advisor direct file access, the Advisor itself may page through `read_snapshot`; the Orchestrator must not read and relay the content.

The Hoonsoo MCP remains authoritative for revision identity even when the Advisor reads the path directly. Check `get_status` before delegation and immediately before publishing. Reject the Advisor result if the revision or semantic hash changed, or if `pendingMeaningfulChange` is true.

## MCP lifecycle

Use the read-only `hoonsoo` MCP tools:

- `start_monitor`: starts or reuses one absolute-path monitor. Use the runtime defaults unless the user explicitly asks for diagnostics; the default quiet window is three seconds.
- `read_snapshot`: revision-stable fallback reading. The receiving Advisor, not the Orchestrator, follows pagination when direct file reading is unavailable.
- `wait_for_change`: event-driven local wait. During normal monitoring omit `timeoutMs`; this prevents periodic model wake-ups.
- `get_status`: validates revision, semantic hash, pending state, and terminal state.
- `stop_monitor`: releases timers on every controllable stop.

If these tools are unavailable, report that the plugin must be installed or reloaded. Do not simulate continuous monitoring with repeated shell or filesystem calls.

### Baseline

1. Call `start_monitor` and retain `monitorId`, revision, semantic hash, and path.
2. Delegate the baseline by reference to the Advisor. Do not place document text in the delegation message.
3. Call `get_status` before publishing. If revision/hash differs or a meaningful change is pending, discard the draft and restart from the newest stable revision.
4. Publish one numbered natural-language batch for the exact revision.
5. Call `wait_for_change` with `afterRevision` equal to that analyzed revision and no `timeoutMs`. Supplying the handled revision advances the runtime’s last-analysis baseline without an extra acknowledgement call.

### Event loop

Handle states as follows:

- `changed`: use only the event reference fields for delegation. The runtime delta is already accumulated from the last revision passed back as handled. If `type` is `replaced`, or `rebaselineRequired` is true, have the Advisor read the current file as a new baseline.
- `idle-warning`: output the exact notice below once, incrementing the batch number, then call `wait_for_change` again for the same handled revision with no `timeoutMs`:

  ```text
  {n} 번째 훈수 :
  1분 간, 작업이 감지되지 않습니다. 추가 30초 대기 후, 훈수모드가 정지됩니다.
  추후 다시 훈수모드를 켜시려면 스킬을 다시 실행해주세요.
  ```

- `idle-stopped`: the runtime already stopped after 90 seconds of meaningful-content inactivity. End the Hoonsoo run without restarting it.
- `deleted`: report deletion once; after its revision is handled, the monitor is terminal.
- `stopped` or `error`: report the reason once and end.
- `cancelled`: inspect the newest user request and status. Stop if the user cancelled; otherwise resume safely.
- `timeout`: this is diagnostic-only. Do not emit a heartbeat; resume with a no-timeout wait.

Whitespace, tab, and line-break-only writes do not increment revision, reset the idle clock, or invoke the Advisor. Repeated meaningful writes inside the quiet window are coalesced, and the Advisor is called only after no further meaningful change has been observed for three seconds.

## Stale-result gate

- Bind every draft to one revision and semantic hash.
- Discard unpublished work if a newer revision exists or `pendingMeaningfulChange` becomes true.
- Do not acknowledge a discarded revision. Wait again using the last revision actually analyzed and published so the runtime returns the newest accumulated delta from that baseline.
- Never merge unlabeled findings from different revisions or repeat unchanged advice unless the new range affects it.

## Natural-language output

Maintain a one-based batch counter for the run. Use this presentation:

```text
{n} 번째 훈수 :
revision: {revision}

현재 문서에서 확인한 문제를 자연스럽게 설명합니다. 이어서 왜 중요한지 설명하고, 사용자가 취할 수 있는 구체적인 조치를 문장으로 제안합니다.
```

`revision:`은 표시하되 `anchor:`, `category:`, `severity:`, `message:`, `rationale:`, `suggestedAction:`, `confidence:` 같은 구조화 필드 라벨은 출력하지 마세요. 위치와 중요도, 근거와 권장 조치는 사람이 말하듯 문장 속에 녹입니다. 여러 항목은 읽기 쉬운 문단이나 번호 목록으로 정리할 수 있습니다. 실행 가능한 지적이 없으면 같은 형식으로 짧게 말하고 억지로 문제를 만들지 마세요.

## Optional context tools

Hoonsoo 자체 MCP 외에는 필수 플러그인이 없습니다. 다만 조언의 근거에 실제로 도움이 될 때만, 이미 연결된 읽기 전용 도구를 사용하거나 한 번 추천할 수 있습니다. 예를 들면 저장소·PR 문맥에는 GitHub/GitLab, Jira·Confluence 문맥에는 Atlassian Rovo, 화면 명세에는 Figma, 연관 문서에는 Google Drive·Dropbox·Box, 최신 API 사실에는 공식 문서나 OpenAI Docs가 유용할 수 있습니다. 자동 설치·연결하거나 같은 추천을 반복하지 마세요.

## Stop conditions

Stop on explicit user cancellation, target deletion/unreadability, runtime terminal state, or the 90-second idle stop. On a controllable stop, call `stop_monitor` before the final response. Monitoring cannot continue after the host ends the active turn; a later run must invoke Hoonsoo again.
