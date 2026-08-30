# skill-hoonsoo

`skill-hoonsoo`는 편집 중인 로컬 문서를 계속 관찰하면서 `context` 또는 `grammar` 관점의 훈수를 제공하는 **Codex·Claude Code 겸용 읽기 전용 플러그인**입니다. 대상 문서와 워크스페이스를 수정하지 않으며, 모든 제안은 적용되지 않은 조언으로만 전달합니다.

## 제공 기능

- 최초 문서 전체를 기준선으로 검토한 뒤 저장된 변경분을 revision 단위로 검토
- `context`: 내용의 완결성, 일관성, 명확성, 위험, 누락된 전제, 실행 가능성 검토
- `grammar`: 파일 문법과 자연어 문법·맞춤법·문장부호·스타일·용어 일관성 검토
- 새 변경이 들어오면 이전 revision의 미발행 결과를 폐기하는 stale 방지
- `start_monitor`, `read_snapshot`, `wait_for_change`, `get_status`, `stop_monitor`로 구성된 읽기 전용 MCP 도구

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
$hoonsoo context /absolute/path/to/design.md
누락된 전제와 아키텍처 경계의 모순을 우선해서 검토하고, 내가 저장할 때마다 계속 기다려줘.
```

Claude Code에서는 재시작하거나 `/reload-plugins`를 실행한 뒤 namespaced command로 호출합니다.

```text
/skill-hoonsoo:hoonsoo grammar /absolute/path/to/README.md
한국어 맞춤법과 용어 일관성을 우선해서 계속 감시해줘.
```

암시 호출도 지원하므로 “이 문서를 context 관점으로 계속 감시해줘”처럼 요청할 수 있지만, 초기 시운전에서는 명시 호출이 설치 문제와 동작 문제를 구분하기 쉽습니다.

### 권장 시운전

1. baseline 훈수에 정확한 revision이 표시되는지 확인합니다.
2. 외부 편집기에서 대상 파일을 수정하고 저장합니다. Hoonsoo 자신은 파일을 수정하지 않습니다.
3. 새 revision과 변경 위치가 포함된 훈수가 이어지는지 확인합니다.
4. 빠르게 여러 번 저장해 오래된 revision의 결과가 현재 결과처럼 출력되지 않는지 확인합니다.
5. `훈수 그만` 또는 `stop Hoonsoo`라고 요청하고 monitor가 종료되는지 확인합니다.

## 동작 구조

```text
활성 agent turn
  -> start_monitor + read_snapshot
  -> baseline review + revision 확인
  -> wait_for_change (최대 50초 long-poll)
       ├─ timeout  -> 다시 wait_for_change
       ├─ changed  -> delta review + stale 확인 -> 훈수
       ├─ replaced -> 새 baseline review
       └─ deleted  -> 알림 + stop_monitor
```

```text
skill-hoonsoo/
├── .agents/plugins/marketplace.json   # Codex marketplace
├── .claude-plugin/marketplace.json    # Claude Code marketplace
├── plugins/skill-hoonsoo/             # 두 호스트가 설치하는 self-contained 배포본
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

- **능동 loop는 현재 agent turn이 실행 중일 때만 유지됩니다.** 호스트가 final 응답을 반환한 뒤 runtime이 스스로 새 메시지를 push할 수는 없습니다. 다시 감시하려면 Hoonsoo를 다시 호출해야 합니다.
- 설치·갱신 직후에는 Codex의 새 task 또는 Claude Code의 reload/restart가 필요합니다.
- snapshot은 페이지 단위로 읽습니다. 매우 큰 문서는 baseline 검토가 여러 batch로 나뉠 수 있습니다.
- 변경 delta와 event history가 잘리거나 파일이 교체되면 현재 snapshot을 다시 읽어 rebaseline합니다.
- monitor 상태는 메모리에만 있으며 agent/MCP process 재시작 뒤 복구되지 않습니다.
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

`schemas/hoonsoo.manifest.schema.json`과 `examples/*.json`은 초기 멀티호스트 아키텍처를 탐색할 때 만든 legacy design reference입니다. 현재 실행 계약이나 설치 설정의 기준은 아닙니다. 실제 배포 기준은 `plugins/skill-hoonsoo/`입니다.
