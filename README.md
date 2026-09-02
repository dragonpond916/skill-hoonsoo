# skill-sherpa

`skill-sherpa`는 로컬 문서의 **디스크 저장 상태**를 관찰하고, 내용·구조와 문법·맞춤법을 한 번에 검토하는 **Codex·Claude Code 겸용 읽기 전용 플러그인**입니다. 대상 파일을 수정하지 않으며 모든 제안은 적용되지 않은 조언으로만 전달합니다.

## 공개 인터페이스

복잡한 산행을 안내하는 셰르파처럼, 사용자가 문서를 완성하는 동안 옆에서 방향과 위험을 알려주는 역할을 표현합니다.

- 플러그인: `skill-sherpa`
- Codex: `$sherpa <filepath> <prompt>`
- Claude Code: `/skill-sherpa:sherpa <filepath> <prompt>`
- MCP server: `sherpa`
- 출력: `세르파의 {n}번째 조언 :`

## 제공 기능

- `$sherpa <filepath> <prompt>` 하나로 완결성·일관성·위험·누락과 문법·맞춤법·문장부호·스타일을 함께 검토
- 편집기의 저장되지 않은 버퍼가 아닌, 디스크에 반영된 상태만 감지
- metadata와 raw content hash를 함께 비교하여 같은 크기의 내용 교체와 atomic save도 판별
- 저장 즉시 deterministic Monitor/DiffChecker가 snapshot과 변경 범위를 session memory에 versioning
- 공백·탭·줄바꿈만 바뀐 저장도 문법·스타일 검토 대상으로 포함
- 같은 raw content를 다시 저장한 경우 새 revision이나 LLM 검토를 만들지 않음
- 한 번의 current-host LLM pass와 원자적 publish gate로 최신 저장본만 출력
- 응답 공개 후 1분간 내용 변경이 없으면 안내하고, 추가 30초 뒤 자동 종료

출력은 내부 revision을 노출하지 않고 다음처럼 자연어만 사용합니다.

```text
세르파의 1번째 조언 :

현재 저장본에서 확인한 문제, 그 영향, 권장 조치를 사람이 설명하듯 자연스럽게 서술합니다.
```

## 요구 사항

- 플러그인을 지원하는 최신 Codex 또는 Claude Code
- Node.js 18.12 이상
- 5 MiB 이하의 UTF-8 로컬 일반 파일 절대 경로
- 비공개 GitHub Enterprise/GitLab 저장소를 사용할 때는 해당 Git 자격 증명 또는 SSH 접근 권한

설치와 실행에 npm 패키지 다운로드는 필요하지 않습니다. runtime은 Node.js 내장 모듈만 사용합니다.

## Case 1: Git 저장소 URL로 설치

### Codex

GitHub 저장소는 `owner/repository` 형식으로 등록할 수 있습니다.

```bash
codex plugin marketplace add dragonpond916/skill-sherpa --ref main
codex plugin add skill-sherpa@skill-sherpa
```

GitHub Enterprise, GitLab 또는 다른 Git 서버는 전체 HTTPS/SSH URL을 사용합니다.

```bash
codex plugin marketplace add https://git.example.com/group/skill-sherpa.git --ref main
codex plugin add skill-sherpa@skill-sherpa
```

### Claude Code

```bash
claude plugin marketplace add dragonpond916/skill-sherpa
claude plugin install skill-sherpa@skill-sherpa
```

GitHub Enterprise, GitLab 또는 다른 Git 서버에서는 전체 Git URL을 사용합니다.

```bash
claude plugin marketplace add https://git.example.com/group/skill-sherpa.git
claude plugin install skill-sherpa@skill-sherpa
```

Claude Code 안에서는 `/plugin marketplace add <저장소>`와 `/plugin install skill-sherpa@skill-sherpa`로도 실행할 수 있습니다.

## Case 2: ZIP을 풀어 오프라인 설치

1. 인터넷이 되는 환경에서 저장소 ZIP을 내려받습니다.
2. 설치할 PC로 옮겨 압축을 풉니다.
3. 아래 경로를 압축을 푼 저장소 루트의 절대 경로로 바꿉니다. 이 경로에는 `.agents/`, `.claude-plugin/`, `plugins/`가 함께 있어야 합니다.

### Codex

```bash
codex plugin marketplace add /absolute/path/to/downloaded-repository
codex plugin add skill-sherpa@skill-sherpa
```

### Claude Code

```bash
claude plugin marketplace add /absolute/path/to/downloaded-repository
claude plugin install skill-sherpa@skill-sherpa
```

영구 설치 없이 현재 Claude Code 실행에서만 확인하려면 다음처럼 실행할 수 있습니다.

```bash
claude --plugin-dir /absolute/path/to/downloaded-repository/plugins/skill-sherpa
```

로컬 marketplace 방식은 설치 시 네트워크를 사용하지 않습니다. 실행할 PC에는 Node.js가 미리 설치되어 있어야 합니다.

## 설치 후 호출

Codex에서는 설치 후 새 task를 시작합니다.

```text
$sherpa /absolute/path/to/design.md 누락된 전제와 아키텍처 경계의 모순, 한국어 문법을 우선해서 검토해줘.
```

Claude Code에서는 재시작하거나 `/reload-plugins`를 실행한 뒤 호출합니다.

```text
/skill-sherpa:sherpa /absolute/path/to/README.md 한국어 맞춤법과 용어 일관성을 우선해서 검토해줘.
```

경로에 공백이 있다면 따옴표로 감쌉니다. prompt는 선택값이며 생략해도 내용과 문법을 모두 검토합니다.

### 권장 시운전

1. 시작 직후 baseline 조언이 자연어로 출력되고 `revision:` 같은 내부 라벨이 보이지 않는지 확인합니다.
2. 외부 편집기에서 입력만 하고 저장하지 않았을 때 새 조언이 없는지 확인합니다.
3. 저장하면 빠르게 하나의 통합 조언이 나오는지 확인합니다.
4. 같은 byte 길이의 단어를 바꾸어 저장해도 감지되는지 확인합니다.
5. 공백·탭·줄바꿈만 바꿔 저장해도 검토되는지 확인합니다.
6. 내용 변경 없이 다시 저장했을 때 LLM 검토가 생기지 않는지 확인합니다.
7. LLM 응답이 90초를 넘겨도 분석 중 idle 종료가 발생하지 않는지 확인합니다.
8. 응답 공개 후 아무 변경 없이 1분이 지나면 안내가 한 번 나오고, 추가 30초 후 종료되는지 확인합니다.
9. `세르파 중지` 또는 `stop Sherpa`로 즉시 종료되는지 확인합니다.

## 동작 구조

```text
active host agent
  -> Monitor + DiffChecker (deterministic, 250ms polling)
       └─ metadata + raw content hash + saved snapshot/diff
  -> read_review_context
       └─ prompt + bounded document context + aggregate diff + prior feedback
       └─ analysis lease 시작: 검토 중 idle warning/stop 일시 정지
  -> current host model (single combined pass)
       └─ 분야 판단 + 내용 + 문법 조언
  -> publish_feedback (revision/hash/token CAS)
       └─ 최신 결과만 공개하고 idle clock 재시작
  -> wait_for_save (45초 bounded wait, timeout은 조용히 재시도)
       └─ 60초 warning -> 90초 stop
```

정상적인 baseline은 `start_monitor → read_review_context → 한 번의 review → publish_feedback → wait_for_save`로 처리합니다. 이후 저장은 `wait_for_save → read_review_context → 한 번의 review → publish_feedback` 흐름입니다. `get_status`는 취소·오류 진단·복구에만 사용합니다.

runtime이 공개하는 MCP 도구는 정확히 다음 여섯 개입니다.

- `start_monitor`
- `read_review_context`
- `publish_feedback`
- `wait_for_save`
- `get_status`
- `stop_monitor`

`wait_for_save`는 일반적인 60초 MCP tool timeout보다 짧은 45초 단위로 기다립니다. timeout 자체는 사용자에게 표시하지 않고 즉시 다시 기다립니다. 작은 도구 호출이 조금 늘 수 있지만, host timeout으로 감시가 끊기는 위험을 줄입니다.

### 선택적으로 유용한 MCP·플러그인

기본 감시에는 Sherpa MCP 하나만 필요합니다. 실제 근거가 필요할 때만 GitHub/GitLab, Atlassian Rovo, Figma, Google Drive·Dropbox·Box, 공식 문서 같은 이미 연결된 읽기 전용 자료를 사용하거나 추천합니다. Sherpa가 자동 설치하거나 연결하지는 않습니다.

## 현실적인 제약

- 능동 loop는 현재 agent turn이 실행 중일 때만 유지됩니다. 호스트의 final 응답이나 90초 idle 종료 뒤에는 다시 Sherpa를 호출해야 합니다.
- 파일시스템은 수동 Save와 autosave를 구분하지 못합니다. 둘 다 디스크 저장으로 처리합니다.
- 저장되지 않은 편집기 버퍼는 감지하지 않습니다. 외부 formatter가 파일을 쓰면 저장 revision으로 감지될 수 있습니다.
- 매우 빠른 여러 저장이 운영체제에서 하나의 상태로 합쳐지면 관찰되지 않은 중간 상태는 복원할 수 없습니다.
- snapshot, diff, review token, feedback은 하나의 MCP process memory에만 있고 monitor나 process가 끝나면 폐기됩니다.
- 대상 파일 접근 권한이나 sandbox가 읽기를 막으면 감시를 시작할 수 없습니다.
- Sherpa는 advice-only입니다. 자동 수정·formatting·파일 생성·삭제를 지원하지 않습니다.

## 개발과 검증

원본을 변경한 뒤 설치용 배포본을 동기화합니다.

```bash
npm run package:plugin
npm test
```

테스트는 6-tool 공개 계약, save detection, revision/hash CAS, 분석 lease와 idle lifecycle, Codex·Claude manifest, 배포본 byte 동기화를 확인합니다.

```text
skill-sherpa/
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
├── .codex-plugin/plugin.json
├── claude.mcp.json
├── skills/sherpa/
├── scripts/sherpa-mcp.mjs
├── plugins/skill-sherpa/       # self-contained 설치 배포본
├── tools/package-plugin.mjs
├── tests/
├── examples/
└── schemas/
```

`schemas/sherpa.manifest.schema.json`과 `examples/sherpa.manifest.json`은 현재 동작 구조의 설계 reference입니다. 실제 설치 기준은 `plugins/skill-sherpa/`입니다.
