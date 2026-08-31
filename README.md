# skill-hoonsoo

`skill-hoonsoo`는 로컬 문서의 **저장된 revision**을 관찰하고, 내용·구조와 문법·맞춤법을 한 번에 검토하는 **Codex·Claude Code 겸용 읽기 전용 플러그인**입니다. 대상 문서와 워크스페이스를 수정하지 않으며, 모든 제안은 적용되지 않은 조언으로만 전달합니다.

## 제공 기능

- `$hoonsoo <filepath> <prompt>` 하나로 내용의 완결성·일관성·위험과 파일 문법·맞춤법·문장부호·스타일을 함께 검토
- 편집기의 저장되지 않은 버퍼는 읽지 않고, 변경이 디스크에 반영된 저장 상태만 감지
- 파일 크기뿐 아니라 metadata와 raw content hash를 비교하여 같은 크기의 내용 교체와 atomic save도 판별
- 저장 직후 deterministic DiffChecker가 이전 저장 revision과 비교하고 snapshot과 diff를 session memory에 versioning
- 공백·탭·줄바꿈만 변경한 저장도 문법과 스타일 검토 대상으로 포함
- 동일한 내용을 다시 저장한 경우에는 새 content revision이나 LLM 호출을 만들지 않음
- 1분간 디스크에 반영된 내용 변경이 없으면 안내하고, 추가 30초 뒤 자동 종료
- revision만 라벨로 표시하고 문제·영향·권장 조치를 사람이 설명하듯 자연어로 출력
- Agent 사이에는 문서 본문 대신 revision별 session-memory reference만 전달
- `start_monitor`, `read_revision`, `wait_for_save`, revision artifact 도구, `get_status`, `stop_monitor`로 구성된 MCP runtime

## 요구 사항

- 플러그인을 지원하는 최신 Codex 또는 Claude Code
- Node.js 18.12 이상
- 5 MiB 이하의 UTF-8 로컬 일반 파일 절대 경로
- 비공개 GitHub Enterprise/GitLab 저장소를 사용할 때는 해당 Git 자격 증명 또는 SSH 접근 권한

플러그인의 설치와 실행 자체에는 npm 패키지 다운로드가 필요하지 않습니다. runtime은 Node.js 내장 모듈만 사용합니다.

## Case 1: Git 저장소 URL로 설치

### Codex

GitHub 저장소는 `owner/repo` 형식으로 등록할 수 있습니다.

```bash
codex plugin marketplace add dragonpond916/skill-hoonsoo --ref main
codex plugin add skill-hoonsoo@skill-hoonsoo
```

GitHub Enterprise, GitLab 또는 다른 Git 서버는 전체 HTTPS/SSH URL을 사용합니다.

```bash
codex plugin marketplace add https://git.example.com/group/skill-hoonsoo.git --ref main
codex plugin add skill-hoonsoo@skill-hoonsoo
```

Codex CLI가 지원하는 marketplace source는 로컬 경로, `owner/repo`, HTTPS Git URL, SSH Git URL입니다. 자세한 계약은 [OpenAI의 Build plugins 문서](https://developers.openai.com/plugins/build/plugins)를 참고하세요.

### Claude Code

GitHub 저장소를 등록하고 플러그인을 설치합니다.

```bash
claude plugin marketplace add dragonpond916/skill-hoonsoo
claude plugin install skill-hoonsoo@skill-hoonsoo
```

GitHub Enterprise, GitLab 또는 다른 Git 서버는 전체 Git URL을 사용합니다.

```bash
claude plugin marketplace add https://git.example.com/group/skill-hoonsoo.git
claude plugin install skill-hoonsoo@skill-hoonsoo
```

Claude Code 안에서는 같은 작업을 `/plugin marketplace add <저장소>`와 `/plugin install skill-hoonsoo@skill-hoonsoo`로 실행할 수도 있습니다. 자세한 형식은 [Claude Code marketplace 문서](https://code.claude.com/docs/en/plugin-marketplaces)와 [플러그인 설치 문서](https://code.claude.com/docs/en/discover-plugins)를 참고하세요.

## Case 2: ZIP을 풀어 오프라인 설치

1. 인터넷이 되는 환경에서 저장소 ZIP을 내려받습니다.
2. 설치할 PC로 옮겨 압축을 풉니다.
3. 아래 명령의 경로를 **압축을 푼 저장소 루트의 절대 경로**로 바꿉니다. 이 경로에는 `.agents/`, `.claude-plugin/`, `plugins/`가 함께 있어야 합니다.

### Codex

```bash
codex plugin marketplace add /absolute/path/to/skill-hoonsoo-main
codex plugin add skill-hoonsoo@skill-hoonsoo
```

### Claude Code

```bash
claude plugin marketplace add /absolute/path/to/skill-hoonsoo-main
claude plugin install skill-hoonsoo@skill-hoonsoo
```

영구 설치 없이 현재 Claude Code 실행에서만 확인하려면 다음 방식도 사용할 수 있습니다.

```bash
claude --plugin-dir /absolute/path/to/skill-hoonsoo-main/plugins/skill-hoonsoo
```

로컬 marketplace 방식은 설치 시 네트워크를 사용하지 않습니다. 단, 실행할 PC에 Node.js가 이미 설치되어 있어야 합니다.

## 설치 후 호출

설치 후 Codex에서는 새 task를 시작하고 다음처럼 호출합니다.

```text
$hoonsoo /absolute/path/to/design.md 누락된 전제와 아키텍처 경계의 모순, 한국어 문법을 우선해서 검토해줘.
```

경로에 공백이 있다면 따옴표로 감쌉니다. 뒤의 prompt는 선택값이며 생략해도 내용·구조·문법을 모두 검토합니다.

Claude Code에서는 재시작하거나 `/reload-plugins`를 실행한 뒤 namespaced command로 호출합니다.

```text
/skill-hoonsoo:hoonsoo /absolute/path/to/README.md 한국어 맞춤법과 용어 일관성을 우선해서 검토해줘.
```

암시 호출도 지원하므로 “이 문서를 저장할 때마다 내용과 문법을 함께 검토해줘”처럼 요청할 수 있지만, 초기 시운전에서는 명시 호출이 설치 문제와 동작 문제를 구분하기 쉽습니다.

### 권장 시운전

1. baseline 훈수에 정확한 revision이 표시되고 내용과 문법이 함께 검토되는지 확인합니다.
2. 외부 편집기에서 입력만 하고 저장하지 않았을 때 아무 revision도 발생하지 않는지 확인합니다.
3. 파일을 저장하면 디스크에 반영된 한 revision에 대한 훈수가 시작되는지 확인합니다. Hoonsoo 자신은 파일을 수정하지 않습니다.
4. 같은 byte 길이의 단어를 다른 단어로 바꾸어 저장해도 감지되는지 확인합니다.
5. 공백·탭·줄바꿈만 바꿔 저장했을 때 문법·스타일 변경으로 검토되는지 확인합니다.
6. 내용 수정 없이 다시 저장했을 때 LLM 훈수가 새로 발생하지 않는지 확인합니다.
7. 출력이 `{n} 번째 훈수 :`와 `revision:`으로 시작하고 나머지는 key:value가 아닌 자연어인지 확인합니다.
8. 아무 내용 변경 없이 1분이 지나면 안내가 한 번 나오고, 추가 30초 후 자동 종료되는지 확인합니다.
9. `훈수 그만` 또는 `stop Hoonsoo`라고 요청하고 monitor가 즉시 종료되는지 확인합니다.

## 동작 구조

```text
활성 agent turn
  -> Monitor (deterministic)
       └─ metadata + raw contentHash로 디스크 반영 상태 감지
  -> DiffChecker (deterministic)
       └─ saved snapshot + diff를 revision별 session memory에 저장
  -> FieldChecker (low-cost LLM)
       └─ diff reference를 읽고 문서 분야·검토 초점을 분석하여 versioning
  -> Main Reviewer (flagship LLM)
       └─ field-analysis + 사용자 prompt + 관련 prior-feedback reference로 통합 훈수 생성
  -> host Session Orchestrator
       ├─ wait_for_save (timeout 없는 event-driven local wait)
       ├─ 60초 idle-warning -> 안내 1회
       ├─ 90초 idle-stopped -> 자동 종료
       └─ deleted/error/user stop -> session memory 정리 후 종료
```

파일 관찰, raw content 비교, diff, revision versioning, idle clock은 Node.js 로컬 runtime이 처리하므로 이 구간에는 모델 호출이 없습니다. 저장 후보를 감지한 뒤 고정 quiet-window를 기다리는 debounce/throttle 단계가 없으며, `wait_for_save`도 정상 실행에서는 `timeoutMs`를 생략해 주기적인 heartbeat와 재호출을 만들지 않습니다. LLM 처리 중 여러 revision이 누적되면 오래된 결과를 버리고 마지막으로 공개한 revision부터 최신 revision까지의 aggregate diff를 사용합니다. 동일한 raw content hash의 재저장은 FieldChecker와 Main Reviewer를 호출하지 않습니다.

runtime은 `start_monitor`, `read_revision`, `wait_for_save`, `read_diff_artifact`, `store_field_analysis`, `read_field_analysis`, `read_review_bundle`, `store_feedback_draft`, `read_feedback_artifact`, `mark_feedback_published`, `get_status`, `stop_monitor` 도구를 제공합니다. 저장 도구가 쓰는 곳은 대상 파일이나 workspace가 아니라 해당 monitor의 격리된 session memory뿐이며, monitor가 끝나면 폐기됩니다.

### 모델 라우팅

- Monitor와 DiffChecker는 LLM Agent가 아니라 deterministic runtime 역할입니다.
- FieldChecker는 저장된 diff를 읽고 분야와 검토 초점을 분류하는 저비용 LLM 역할입니다.
  - Codex: 지원되는 경우 `gpt-5.6-luna`를 요청합니다.
  - Claude Code: 배포본의 `agents/hoonsoo-field-checker.md`가 `haiku` alias를 요청합니다.
- Main Reviewer만 최종 내용·구조·문법 판단과 자연어 훈수를 담당합니다.
  - Codex: 지원되는 경우 `gpt-5.6-sol` + `high` reasoning을 요청합니다.
  - Claude Code: 배포본의 `agents/hoonsoo-advisor.md`가 `fable` alias + `high` effort를 요청합니다.
- 호스트·조직 정책상 모델 override가 불가능하면 현재 세션 모델로 fallback합니다. 플러그인이 별도의 API key를 요구하거나 몰래 외부 Model API를 호출하지는 않습니다.

Agent 사이에는 문서 본문이나 diff 내용을 복사하지 않습니다. `monitorId`, `revision`, `contentHash`, `sourceArtifactRef`, `fieldAnalysisRef`, `promptRef`만 전달하고 각 Agent가 필요한 versioned artifact를 MCP에서 직접 읽습니다. 이전 훈수도 Agent 메시지로 재전송하지 않고 Main Reviewer가 review bundle을 통해 session memory에서 직접 읽습니다.

### 선택적으로 유용한 MCP·플러그인

기본 감시에는 Hoonsoo MCP 하나만 필요합니다. 훈수 근거에 실제로 필요한 경우에만 GitHub/GitLab(저장소·PR), Atlassian Rovo(Jira·Confluence), Figma(화면 명세), Google Drive·Dropbox·Box(연관 문서), 공식 문서/OpenAI Docs(최신 API 사실)를 읽기 전용으로 연결하거나 추천할 수 있습니다. Hoonsoo가 이를 자동 설치하거나 상시 로드하지는 않습니다.

```text
skill-hoonsoo/
├── .agents/plugins/marketplace.json   # Codex marketplace
├── .claude-plugin/marketplace.json    # Claude Code marketplace
├── plugins/skill-hoonsoo/             # 두 호스트가 설치하는 self-contained 배포본
├── agents/hoonsoo-advisor.md           # Claude Code용 Fable Advisor
├── agents/hoonsoo-field-checker.md     # Claude Code용 저비용 FieldChecker
├── .codex-plugin/plugin.json          # Codex manifest 원본
├── .claude-plugin/plugin.json         # Claude Code manifest 원본
├── claude.mcp.json                    # Claude Code용 MCP 실행 경로
├── skills/hoonsoo/                    # 공용 skill 원본
├── scripts/hoonsoo-mcp.mjs            # 읽기 전용 monitor/diff runtime
├── tools/package-plugin.mjs           # 배포본 결정적 동기화
└── tests/                              # runtime·배포 계약 테스트
```

두 호스트의 MCP 설정은 분리되어 있습니다. Claude Code manifest는 `${CLAUDE_PLUGIN_ROOT}`를 사용하는 `claude.mcp.json`을 참조하고, Codex manifest는 플러그인 루트의 `cwd`와 상대 경로를 직접 선언합니다.

## 현실적인 제약

- **능동 loop는 현재 agent turn이 실행 중일 때만 유지됩니다.** 90초 idle 종료나 호스트의 final 응답 뒤에는 runtime이 스스로 새 메시지를 push할 수 없습니다. 다시 감시하려면 Hoonsoo를 다시 호출해야 합니다.
- 파일시스템은 수동 Save 버튼과 에디터 autosave를 구분하지 못합니다. Hoonsoo의 “저장 감지”는 변경된 내용이 디스크에 반영된 상태를 의미하며, autosave도 저장으로 취급합니다.
- 저장되지 않은 편집기 버퍼는 감지하지 않습니다. 반대로 외부 formatter가 대상 파일을 디스크에 기록하면 저장된 revision으로 감지될 수 있습니다.
- 빠른 여러 저장이 운영체제나 watcher에서 하나의 디스크 상태로 합쳐지면 중간 상태를 복원할 수 없습니다. runtime은 실제로 관찰한 저장 상태마다 revision을 만듭니다.
- 설치·갱신 직후에는 Codex의 새 task 또는 Claude Code의 reload/restart가 필요합니다.
- revision snapshot, diff, Field 분석, feedback draft는 해당 monitor의 session memory에만 있으며 monitor 또는 MCP process가 끝나면 복구되지 않습니다.
- artifact history가 제한을 넘어 과거 기준 revision을 읽을 수 없으면 runtime이 `rebaselineRequired`를 반환하고 현재 저장 snapshot을 새 source로 사용합니다. 파일 교체 저장은 새 inode의 일반 content revision으로 기록합니다.
- 대상 파일 접근 권한이나 sandbox가 읽기를 막으면 감시를 시작할 수 없습니다.
- Hoonsoo는 advice-only입니다. 제안 적용, 자동 formatting, 파일 생성·수정·삭제는 지원하지 않습니다.

## 개발과 검증

원본을 변경한 뒤 marketplace가 설치할 최소 배포본을 동기화합니다.

```bash
npm run package:plugin
npm test
```

`npm test`는 배포본이 원본과 byte-for-byte 같은지, Codex·Claude marketplace와 manifest가 올바른지, 두 호스트 설정에서 패키지 내부 MCP runtime이 실제로 기동되는지, monitor의 revision/diff 계약이 유지되는지를 검증합니다.

Codex manifest와 skill metadata는 각각 Codex에 번들된 `plugin-creator`, `skill-creator` validator로 추가 확인할 수 있습니다.

## Legacy 설계 자료

`schemas/hoonsoo.manifest.schema.json`과 `examples/*.json`은 멀티호스트 아키텍처를 설명하는 design reference입니다. 여기에는 save-aware deterministic Monitor/DiffChecker, 저비용 FieldChecker, flagship Main Reviewer, versioned session-memory reference 전달 정책이 명시되어 있지만 현재 실행·설치 계약의 기준은 아닙니다. 실제 배포 기준은 `plugins/skill-hoonsoo/`입니다.
