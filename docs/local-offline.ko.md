# 로컬 / 오프라인 MBrain 가이드

이 문서는 **Supabase, OpenAI, Anthropic 같은 필수 클라우드 서비스 없이** MBrain을 설치하고 바로 사용하는 방법을 설명합니다.

이 모드에서는:

- 마크다운 저장소가 계속 source of truth 역할을 하고
- MBrain은 로컬 SQLite 파일에 인덱스를 저장하며
- `mbrain serve`가 로컬 stdio MCP 서버 역할을 하고
- 키워드 검색은 즉시 가능하며
- 임베딩/로컬 LLM 재작성은 나중에 선택적으로 붙일 수 있습니다

영문 문서는 [docs/local-offline.md](local-offline.md)를 참고하세요.

---

## 1. 어떤 경우에 local/offline 모드를 써야 하나요?

다음 조건이면 local/offline 모드가 적합합니다.

- 개인용 지식 저장소를 한 대의 컴퓨터에서 돌리고 싶다
- 반복적인 클라우드 비용을 피하고 싶다
- Codex / Claude Code에서 로컬 MCP로 붙이고 싶다
- Postgres 대신 SQLite로 시작하고 싶다

다음이 필요하면 managed Postgres 경로가 더 적합합니다.

- 대규모 hosted pgvector 검색
- HTTP 기반 remote MCP
- `mbrain files ...` 같은 클라우드 파일/스토리지 워크플로우

이 문서는 **SQLite 기반 local/offline 경로만** 다룹니다.

---

## 2. `mbrain init --local`이 실제로 만드는 것

`mbrain init --local`을 실행하면:

1. SQLite 데이터베이스를 만들고
2. 필요한 스키마를 초기화하고
3. `~/.mbrain/config.json`에 local/offline 설정을 저장합니다

예시:

```json
{
  "engine": "sqlite",
  "database_path": "/Users/alice/.mbrain/brain.db",
  "offline": true,
  "embedding_provider": "local",
  "embedding_model": "nomic-embed-text",
  "query_rewrite_provider": "heuristic"
}
```

중요:

- 실제 저장되는 `database_path`는 **절대 경로**
- 즉 `~/.mbrain/brain.db` 문자열 그대로 저장되지 않습니다

---

## 3. 가장 빠른 설치/사용 순서

처음부터 바로 따라 하려면 아래 순서대로 실행하면 됩니다.

```bash
# 1) bun 설치 (이미 있으면 생략)
curl -fsSL https://bun.com/install | bash

# 2) 셸 다시 로드
exec /bin/zsh

# 3) mbrain 전역 설치
bun add -g github:meghendra6/mbrain

# 4) 로컬 SQLite brain 생성
mbrain init --local

# 5) 마크다운 저장소 import
mbrain import ~/git/brain

# 6) 검색 동작 확인
mbrain query "내 노트에 실제로 있을 만한 문장"

# 7) MCP 서버 실행
mbrain serve
```

여기까지 하면:

- 로컬 SQLite에 인덱스가 생기고
- 키워드 검색이 바로 가능하며
- Codex / Claude Code가 MCP로 붙을 준비가 됩니다

임베딩은 아직 없어도 됩니다.

---

## 4. 단계별 상세 설치

### Step 1: Bun 설치

이미 `bun --version`이 되면 생략하세요.

```bash
curl -fsSL https://bun.com/install | bash
exec /bin/zsh
bun --version
```

정상이라면 버전 문자열이 출력됩니다.

### Step 2: MBrain 설치

```bash
bun add -g github:meghendra6/mbrain
mbrain --version
```

로컬 source checkout에서 설치하는 경우에는 source symlink에 의존하지 말고
standalone binary를 빌드해서 사용자 `PATH`에 넣습니다.

```bash
bun install
bun run build
mkdir -p "$HOME/.local/bin"
install -m 755 bin/mbrain "$HOME/.local/bin/mbrain"
command -v mbrain
mbrain --version
```

`bun link`는 전역 명령을 checkout의 `src/cli.ts`로 연결하므로, 해당
checkout에 의존성이 설치되어 있어야 합니다. 위의 compiled binary 방식이
안정적인 로컬 checkout 설치 경로입니다. `command -v mbrain` 결과가
`$HOME/.local/bin/mbrain`이 아니라면 계속 진행하기 전에 `$HOME/.local/bin`을
셸 `PATH`에 추가하세요.

### Step 3: local brain 초기화

기본 경로:

```bash
mbrain init --local
```

커스텀 SQLite 경로:

```bash
mbrain init --local --path ~/brains/personal-brain.db
```

정상 결과:

- SQLite 파일 생성
- `~/.mbrain/config.json` 생성
- 실제 SQLite 경로 출력

### Step 4: 마크다운 저장소 import

```bash
mbrain import /path/to/your/brain
```

예:

```bash
mbrain import ~/git/brain
mbrain import ~/Documents/obsidian-vault
```

정상 결과:

- 페이지/청크가 SQLite에 저장됨
- 키워드 검색이 즉시 가능
- 임베딩은 나중에 `mbrain embed`로 별도 backfill 가능

### Step 5: 바로 검색해보기

```bash
mbrain query "what do we know about competitive dynamics?"
mbrain search "Pedro"
mbrain stats
mbrain health
```

---

## 5. local/offline 모드에서 임베딩은 선택사항입니다

현재 MBrain은 local/offline 모드에서 **text-first, embed-later** 전략으로 동작합니다.

즉:

- `mbrain import`가 임베딩 때문에 막히지 않고
- `mbrain sync`도 임베딩 때문에 막히지 않으며
- `mbrain embed`가 명시적인 backfill 경로가 됩니다

마크다운은 계속 durable source of truth입니다. `mbrain import <repo>` 또는
`mbrain sync --repo <repo>`를 실행하면 MBrain이 해당 마크다운 저장소 경로를
기억합니다. 이후 CLI나 MCP 서버의 `put_page` 쓰기는 먼저 대응하는
`<slug>.md` 파일을 저장한 뒤, 그 파일을 SQLite로 다시 import합니다. 마지막
import 이후 사용자가 마크다운 파일을 직접 수정했다면, `put_page`는 사용자
파일을 덮어쓰지 않고 conflict를 반환합니다.

### 옵션 A: 임베딩 없이 먼저 사용

아무 것도 추가 설정하지 않아도 됩니다.

이 상태에서도:

- 페이지 CRUD
- 키워드 검색
- 링크 / 그래프 / 타임라인 / 통계
- `mbrain serve` 기반 MCP

는 정상 동작합니다.

### 옵션 B: 나중에 로컬 임베딩 런타임 연결

MBrain은 임베딩 런타임을 아래 순서로 결정합니다.

1. `MBRAIN_LOCAL_EMBEDDING_URL`
2. `OLLAMA_HOST` (`/api/embed` 사용)
3. 기본 Ollama 엔드포인트 `http://127.0.0.1:11434/api/embed`

Ollama가 기본 호스트/포트로 떠 있고 기본 모델을 쓸 거라면, 런타임 URL 관련 추가 설정 없이 바로 실행하면 됩니다.

```bash
mbrain embed --stale
```

기본 모델은 `nomic-embed-text`입니다. MBrain이 retrieval prefix를 내부적으로
자동 적용하므로 문서 청크는 `search_document:`, 검색 질의는 `search_query:`
형태로 처리됩니다.

커스텀 호스트/포트나 다른 모델을 쓰는 경우에만 필요한 값만 override 하세요.

```bash
export OLLAMA_HOST=http://127.0.0.1:11434
export MBRAIN_LOCAL_EMBEDDING_MODEL=nomic-embed-text
mbrain embed --stale
```

옵션:

```bash
export MBRAIN_LOCAL_EMBEDDING_DIMENSIONS=768
```

자주 쓰는 명령:

```bash
mbrain embed --stale
mbrain embed --all
mbrain embed notes/offline-demo
```

동작 의미:

- `--stale` : 아직 임베딩되지 않은 청크만 backfill
- `mbrain embed <slug>` : 해당 페이지 전체를 명시적으로 rebuild 가능
- 기본 엔드포인트에 Ollama가 없으면 `OLLAMA_HOST` 또는 `MBRAIN_LOCAL_EMBEDDING_URL`로 override
- 런타임은 보이지만 모델이 없으면 Ollama가 그 에러를 그대로 돌려줌

---

## 6. query rewrite도 선택사항입니다

기본 local/offline 설정은:

```json
"query_rewrite_provider": "heuristic"
```

즉:

- LLM 런타임이 없어도 검색 가능
- 기본적으로는 heuristic rewrite만 사용

로컬 LLM rewrite를 쓰려면:

```json
"query_rewrite_provider": "local_llm"
```

그리고 아래 중 하나를 설정합니다.

- `MBRAIN_LOCAL_LLM_URL`
- `OLLAMA_HOST` (`/api/generate` 사용)

선택적 모델 지정:

```bash
export MBRAIN_LOCAL_LLM_MODEL=qwen2.5:3b
```

런타임이 없거나, 응답이 깨졌거나, 에러가 나면 원래 쿼리로 안전하게 fallback 됩니다.

---

## 7. Codex에서 바로 붙이는 방법

먼저 local brain을 초기화합니다.

```bash
mbrain init --local
```

그 다음 MCP 서버를 추가합니다.

```bash
codex mcp add mbrain -- mbrain serve
```

이 의미는:

- Codex가 `mbrain serve`를 실행하고
- `mbrain serve`가 `~/.mbrain/config.json`을 읽고
- 로컬 SQLite brain에 MCP tool 호출을 전달한다는 뜻입니다

권장 확인 방법:

1. 새 Codex 세션 시작
2. MBrain tool listing 또는 간단한 query 실행

비표준 config 디렉터리를 써야 한다면 wrapper script를 권장합니다.

예:

```bash
#!/bin/zsh
export MBRAIN_CONFIG_DIR="$HOME/.mbrain-alt"
exec mbrain serve
```

그 후 Codex는 `mbrain serve` 대신 이 wrapper를 실행하게 하면 됩니다.

---

## 8. Claude Code에서 붙이는 방법

Codex와 동일한 방식으로 한 줄로 등록할 수 있습니다.

```bash
claude mcp add -s user mbrain -- mbrain serve
```

이 명령의 의미:

- Claude Code가 필요할 때 `mbrain serve`를 자동으로 실행하고
- `mbrain serve`가 `~/.mbrain/config.json`을 읽어
- 모든 MCP 호출을 로컬 SQLite brain으로 전달합니다

`-s user`는 Claude Code의 사용자 범위에 MCP 서버를 등록합니다. 현재
프로젝트에서만 쓰고 싶다면 아래처럼 local scope를 명시합니다.

```bash
claude mcp add -s local mbrain -- mbrain serve
```

권장 순서:

1. `mbrain init --local`
2. `mbrain import /path/to/brain`
3. `claude mcp add -s user mbrain -- mbrain serve`
4. 새 Claude Code 세션 시작
5. 간단한 MBrain tool 호출 확인

CLI 대신 JSON 설정으로 직접 추가하려면 `~/.claude.json` 또는 프로젝트의 `.claude/mcp.json`에 아래를 추가합니다.

```json
{
  "mcpServers": {
    "mbrain": {
      "command": "mbrain",
      "args": ["serve"]
    }
  }
}
```

비표준 config 디렉터리가 필요하면 Codex와 마찬가지로 wrapper script를 쓰는 것이 가장 안전합니다.

---

## 9. 한 명령어로 에이전트 설정: `mbrain setup-agent`

MCP 등록과 행동 규칙 주입을 수동으로 하는 대신, 한 명령어로 처리할 수 있습니다:

```bash
mbrain setup-agent
```

이 명령어는:

1. 설치된 AI 클라이언트를 **자동 감지**합니다 (`~/.claude/` 및/또는 `~/.codex/`)
2. 감지된 클라이언트에 MCP 서버를 **등록**합니다 (이미 등록된 경우 건너뜀)
3. 각 클라이언트의 글로벌 설정에 MBrain 에이전트 규칙을 **주입**합니다
4. Claude Code의 세션 종료 시 mbrain writeback을 요구하는 Stop hook을 **설치**합니다

에이전트 규칙은 brain-agent loop을 가르칩니다: 응답 전에 brain을 먼저 읽고, 새 정보를 다시 기록하고, 매 메시지마다 엔티티를 감지하고, 모든 것을 백링크합니다. 이 규칙 없이는 MCP 도구만 있고 지식 복리 효과가 발생하지 않습니다.

### 옵션

```bash
mbrain setup-agent              # 설치된 모든 클라이언트 자동 감지 및 설정
mbrain setup-agent --claude     # Claude Code만
mbrain setup-agent --codex      # Codex만
mbrain setup-agent --claude --scope local  # Claude 프로젝트-local MCP 등록
mbrain setup-agent --skip-mcp   # 규칙만 주입, MCP 등록 건너뜀
mbrain setup-agent --print      # 파일 쓰기 대신 stdout 출력
mbrain setup-agent --json       # 기계 판독 가능 출력
```

### 어디에 무엇이 쓰이나

| 클라이언트 | MCP 등록 | 규칙 주입 위치 |
|-----------|---------|--------------|
| Claude Code | `claude mcp add -s user mbrain -- mbrain serve` | `~/.claude/CLAUDE.md` |
| Codex | `codex mcp add mbrain -- mbrain serve` | `~/.codex/AGENTS.md` |

Claude Code 등록은 기본적으로 user scope를 사용합니다. 현재 Claude Code
프로젝트에만 등록하고 싶다면 `mbrain setup-agent --claude --scope local`을
사용하세요.

규칙은 `<!-- MBRAIN:RULES:START -->` / `<!-- MBRAIN:RULES:END -->` 마커로 감싸져 기존 내용을 건드리지 않습니다. `setup-agent`를 다시 실행하면 mbrain 섹션만 제자리에서 업데이트됩니다.

Claude Code의 경우 `setup-agent`는 추가로 아래 항목도 설치합니다:

- `~/.claude/scripts/hooks/stop-mbrain-check.sh`
- `~/.claude/scripts/hooks/lib/mbrain-relevance.sh`
- `~/.claude/mbrain-skip-dirs`
- `~/.claude/settings.json`의 Stop hook 엔트리 `stop:mbrain-check`

이 Stop hook은 세션 종료 시 한 번 실행되어, relevant session이면 Claude Code가 새 세션 지식을 mbrain에 기록하거나 `MBRAIN-PASS: <reason>`로 명시적으로 건너뛰도록 요구합니다.

Stop hook이 응답을 막을 때 Claude Code는 이 메시지를 `Stop hook error` 접두어 아래에 표시할 수 있습니다. 이 경우 MBrain hook이 크래시 난 것이 아니라, 세션 종료 전에 마지막 memory check를 요청하는 것입니다. 에이전트는 저장할 만한 세션 지식이 있으면 MBrain에 기록하고 sync해야 하며, 저장할 내용이 없으면 정확히 `MBRAIN-PASS: <short reason>`라고 응답하면 됩니다.

Claude 세션 하나에서만 이 알림을 끄려면:

```bash
MBRAIN_STOP_HOOK=0 claude
```

특정 작업 디렉터리에서 끄려면 절대 경로를 `~/.claude/mbrain-skip-dirs`에 추가하세요.

### 설정 후 확인

AI 클라이언트에서 새 세션을 시작한 뒤:

- MBrain 도구 목록 조회 요청 (`search`, `query`, `get_page` 등이 보여야 함)
- brain에 있는 사람이나 주제에 대해 질문
- 답변 전에 brain을 확인하는지 관찰

---

## 10. Codex와 Claude Code 동시에 사용하기

두 클라이언트 모두 같은 로컬 brain에 동시에 연결할 수 있습니다. 각 클라이언트는 별도로 `mbrain serve` 프로세스를 띄우지만, 둘 다 `~/.mbrain/brain.db`의 동일한 SQLite 파일을 참조합니다. SQLite WAL 모드 덕분에 동시 읽기가 안전합니다.

가장 빠른 설정 방법:

```bash
mbrain init --local
mbrain import ~/git/brain
mbrain setup-agent               # 두 클라이언트 모두 MCP 등록 + 규칙 주입
```

또는 수동으로:

```bash
codex mcp add mbrain -- mbrain serve
claude mcp add -s user mbrain -- mbrain serve
```

이후에는:

- Codex 세션에서 로컬 brain의 모든 기능 사용 가능
- Claude Code 세션에서 로컬 brain의 모든 기능 사용 가능
- 동시 읽기 안전
- 한 세션의 쓰기가 다른 세션에 즉시 반영

두 클라이언트 모두 필요할 때 서버를 자동으로 실행합니다.

---

## 10. 첫날 운영 추천 루틴

```bash
# 1회 bootstrap
mbrain init --local

# 첫 import
mbrain import ~/git/brain

# 일반 검색
mbrain query "what changed with the series A?"
mbrain search "Pedro"

# 저장소 변경 반영
mbrain sync --repo ~/git/brain

# agent/MCP page write는 이제 ~/git/brain에 먼저 write-back
mbrain put concepts/example < page.md

# 임베딩 backfill
mbrain embed --stale
```

MCP를 계속 붙여둘 거면:

```bash
mbrain serve
```

또는 Codex / Claude Code가 필요할 때 자동 실행하게 둘 수 있습니다.

---

## 11. 검증 체크리스트

아래 순서대로 확인하면 됩니다.

```bash
mbrain init --local
mbrain import /path/to/brain
mbrain query "실제로 존재하는 문장"
mbrain doctor --json
mbrain stats
mbrain health
```

`doctor --json` 출력에서는 `local_offline` execution envelope이 보여야 합니다. 클라우드 파일/스토리지처럼 managed/Postgres 전용인 표면은 unsupported capability로 표시될 수 있습니다. SQLite 모드에서는 pgvector와 RLS 검사가 적용 대상이 아니므로, 이것 때문에 local profile이 unhealthy처럼 보이면 안 됩니다.

그 다음 MCP 확인:

1. Codex 또는 Claude Code를 `mbrain serve`에 연결
2. tool listing 성공 여부 확인
3. 간단한 tool call 확인
   - `search`
   - `query`
   - `get_page`

긴 lifecycle E2E test 대신 설치된 명령과 stdio MCP 서버만 빠르게 확인하려면:

```bash
MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp
```

임베딩 런타임을 연결했다면:

```bash
mbrain embed --stale
mbrain health
```

embedding coverage가 올라가야 정상입니다.

---

## 12. local/offline 모드에서 아직 지원하지 않는 것

아래는 아직 managed/Postgres 쪽 기능입니다.

- HTTP 기반 remote MCP
- 클라우드 파일/스토리지 워크플로우 (`mbrain files ...`)
- Supabase admin / deploy helper

local/offline 모드에서는 이런 기능이 “되는 척”하지 않고, 명확하게 unsupported 안내를 주는 것이 정상입니다.

---

## 13. 자주 겪는 문제

### `mbrain init --local`은 됐는데 검색 결과가 없다

아직 import를 안 했을 가능성이 높습니다.

```bash
mbrain import /path/to/brain
mbrain stats
```

### `mbrain embed --stale`가 Ollama 연결 에러로 실패한다

기본적으로 MBrain은 `http://127.0.0.1:11434/api/embed`를 먼저 시도합니다.

로컬 런타임이 다른 호스트/포트에 떠 있다면 다음 중 하나를 설정하세요.

- `MBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST`

그 다음 다시:

```bash
mbrain embed --stale
```

### 터미널에서는 `mbrain serve`가 되는데 MCP client에서는 안 된다

대부분은 클라이언트가 다른 환경/설정 디렉터리를 보고 있기 때문입니다.

해결 방법:

- 기본 `~/.mbrain/config.json` 사용
- 또는 env를 export한 wrapper script를 만들어서 `exec mbrain serve`

### `mbrain files ...`가 local 모드에서 실패한다

현재는 정상입니다.

SQLite local/offline 모드에서는 클라우드 파일/스토리지 워크플로우가 아직 지원되지 않습니다.

---

## 14. 바로 시작용 최소 명령 요약

```bash
bun add -g github:meghendra6/mbrain
mbrain init --local
mbrain import ~/git/brain
mbrain query "내 노트에 있는 문장"
codex mcp add mbrain -- mbrain serve
```
