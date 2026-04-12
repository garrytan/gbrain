# 로컬 / 오프라인 GBrain 가이드

이 문서는 **Supabase, OpenAI, Anthropic 같은 필수 클라우드 서비스 없이** GBrain을 설치하고 바로 사용하는 방법을 설명합니다.

이 모드에서는:

- 마크다운 저장소가 계속 source of truth 역할을 하고
- GBrain은 로컬 SQLite 파일에 인덱스를 저장하며
- `gbrain serve`가 로컬 stdio MCP 서버 역할을 하고
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
- `gbrain files ...` 같은 클라우드 파일/스토리지 워크플로우

이 문서는 **SQLite 기반 local/offline 경로만** 다룹니다.

---

## 2. `gbrain init --local`이 실제로 만드는 것

`gbrain init --local`을 실행하면:

1. SQLite 데이터베이스를 만들고
2. 필요한 스키마를 초기화하고
3. `~/.gbrain/config.json`에 local/offline 설정을 저장합니다

예시:

```json
{
  "engine": "sqlite",
  "database_path": "/Users/alice/.gbrain/brain.db",
  "offline": true,
  "embedding_provider": "local",
  "query_rewrite_provider": "heuristic"
}
```

중요:

- 실제 저장되는 `database_path`는 **절대 경로**
- 즉 `~/.gbrain/brain.db` 문자열 그대로 저장되지 않습니다

---

## 3. 가장 빠른 설치/사용 순서

처음부터 바로 따라 하려면 아래 순서대로 실행하면 됩니다.

```bash
# 1) bun 설치 (이미 있으면 생략)
curl -fsSL https://bun.com/install | bash

# 2) 셸 다시 로드
exec /bin/zsh

# 3) gbrain 전역 설치
bun add -g github:meghendra6/gbrain

# 4) 로컬 SQLite brain 생성
gbrain init --local

# 5) 마크다운 저장소 import
gbrain import ~/git/brain

# 6) 검색 동작 확인
gbrain query "내 노트에 실제로 있을 만한 문장"

# 7) MCP 서버 실행
gbrain serve
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

### Step 2: GBrain 설치

```bash
bun add -g github:meghendra6/gbrain
gbrain --version
```

### Step 3: local brain 초기화

기본 경로:

```bash
gbrain init --local
```

커스텀 SQLite 경로:

```bash
gbrain init --local --path ~/brains/personal-brain.db
```

정상 결과:

- SQLite 파일 생성
- `~/.gbrain/config.json` 생성
- 실제 SQLite 경로 출력

### Step 4: 마크다운 저장소 import

```bash
gbrain import /path/to/your/brain
```

예:

```bash
gbrain import ~/git/brain
gbrain import ~/Documents/obsidian-vault
```

정상 결과:

- 페이지/청크가 SQLite에 저장됨
- 키워드 검색이 즉시 가능
- 임베딩은 나중에 `gbrain embed`로 별도 backfill 가능

### Step 5: 바로 검색해보기

```bash
gbrain query "what do we know about competitive dynamics?"
gbrain search "Pedro"
gbrain stats
gbrain health
```

---

## 5. local/offline 모드에서 임베딩은 선택사항입니다

현재 GBrain은 local/offline 모드에서 **write-first** 전략으로 동작합니다.

즉:

- `gbrain import`가 임베딩 때문에 막히지 않고
- `gbrain sync`도 임베딩 때문에 막히지 않으며
- `gbrain embed`가 명시적인 backfill 경로가 됩니다

### 옵션 A: 임베딩 없이 먼저 사용

아무 것도 추가 설정하지 않아도 됩니다.

이 상태에서도:

- 페이지 CRUD
- 키워드 검색
- 링크 / 그래프 / 타임라인 / 통계
- `gbrain serve` 기반 MCP

는 정상 동작합니다.

### 옵션 B: 나중에 로컬 임베딩 런타임 연결

GBrain은 아래 중 하나를 찾습니다.

- `GBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST` (`/api/embed` 사용)

예시:

```bash
export OLLAMA_HOST=http://127.0.0.1:11434
export GBRAIN_LOCAL_EMBEDDING_MODEL=nomic-embed-text
gbrain embed --stale
```

옵션:

```bash
export GBRAIN_LOCAL_EMBEDDING_DIMENSIONS=768
```

자주 쓰는 명령:

```bash
gbrain embed --stale
gbrain embed --all
gbrain embed notes/offline-demo
```

동작 의미:

- `--stale` : 아직 임베딩되지 않은 청크만 backfill
- `gbrain embed <slug>` : 해당 페이지 전체를 명시적으로 rebuild 가능
- 로컬 런타임이 없으면 GBrain이 솔직하게 unavailable을 알려줌

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

- `GBRAIN_LOCAL_LLM_URL`
- `OLLAMA_HOST` (`/api/generate` 사용)

선택적 모델 지정:

```bash
export GBRAIN_LOCAL_LLM_MODEL=qwen2.5:3b
```

런타임이 없거나, 응답이 깨졌거나, 에러가 나면 원래 쿼리로 안전하게 fallback 됩니다.

---

## 7. Codex에서 바로 붙이는 방법

먼저 local brain을 초기화합니다.

```bash
gbrain init --local
```

그 다음 MCP 서버를 추가합니다.

```bash
codex mcp add gbrain -- gbrain serve
```

이 의미는:

- Codex가 `gbrain serve`를 실행하고
- `gbrain serve`가 `~/.gbrain/config.json`을 읽고
- 로컬 SQLite brain에 MCP tool 호출을 전달한다는 뜻입니다

권장 확인 방법:

1. 새 Codex 세션 시작
2. GBrain tool listing 또는 간단한 query 실행

비표준 config 디렉터리를 써야 한다면 wrapper script를 권장합니다.

예:

```bash
#!/bin/zsh
export GBRAIN_CONFIG_DIR="$HOME/.gbrain-alt"
exec gbrain serve
```

그 후 Codex는 `gbrain serve` 대신 이 wrapper를 실행하게 하면 됩니다.

---

## 8. Claude Code에서 붙이는 방법

Codex와 동일한 방식으로 한 줄로 등록할 수 있습니다.

```bash
claude mcp add gbrain -- gbrain serve
```

이 명령의 의미:

- Claude Code가 필요할 때 `gbrain serve`를 자동으로 실행하고
- `gbrain serve`가 `~/.gbrain/config.json`을 읽어
- 모든 MCP 호출을 로컬 SQLite brain으로 전달합니다

권장 순서:

1. `gbrain init --local`
2. `gbrain import /path/to/brain`
3. `claude mcp add gbrain -- gbrain serve`
4. 새 Claude Code 세션 시작
5. 간단한 GBrain tool 호출 확인

CLI 대신 JSON 설정으로 직접 추가하려면 `~/.claude.json` 또는 프로젝트의 `.claude/mcp.json`에 아래를 추가합니다.

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

비표준 config 디렉터리가 필요하면 Codex와 마찬가지로 wrapper script를 쓰는 것이 가장 안전합니다.

---

## 9. Codex와 Claude Code 동시에 사용하기

두 클라이언트 모두 같은 로컬 brain에 동시에 연결할 수 있습니다. 각 클라이언트는 별도로 `gbrain serve` 프로세스를 띄우지만, 둘 다 `~/.gbrain/brain.db`의 동일한 SQLite 파일을 참조합니다. SQLite WAL 모드 덕분에 동시 읽기가 안전합니다.

한 번에 두 클라이언트 모두 등록하는 방법:

```bash
# 한 번만 초기화
gbrain init --local
gbrain import ~/git/brain

# Codex에 등록
codex mcp add gbrain -- gbrain serve

# Claude Code에 등록
claude mcp add gbrain -- gbrain serve
```

이후에는:

- Codex 세션에서 로컬 brain의 모든 기능 사용 가능
- Claude Code 세션에서 로컬 brain의 모든 기능 사용 가능
- 동시 읽기 안전
- 한 세션의 쓰기가 다른 세션에 즉시 반영

추가 설정은 필요 없으며, 두 클라이언트 모두 필요할 때 서버를 자동으로 실행합니다.

---

## 10. 첫날 운영 추천 루틴

```bash
# 1회 bootstrap
gbrain init --local

# 첫 import
gbrain import ~/git/brain

# 일반 검색
gbrain query "what changed with the series A?"
gbrain search "Pedro"

# 저장소 변경 반영
gbrain sync --repo ~/git/brain

# 임베딩 backfill
gbrain embed --stale
```

MCP를 계속 붙여둘 거면:

```bash
gbrain serve
```

또는 Codex / Claude Code가 필요할 때 자동 실행하게 둘 수 있습니다.

---

## 11. 검증 체크리스트

아래 순서대로 확인하면 됩니다.

```bash
gbrain init --local
gbrain import /path/to/brain
gbrain query "실제로 존재하는 문장"
gbrain stats
gbrain health
```

그 다음 MCP 확인:

1. Codex 또는 Claude Code를 `gbrain serve`에 연결
2. tool listing 성공 여부 확인
3. 간단한 tool call 확인
   - `search`
   - `query`
   - `get_page`

임베딩 런타임을 연결했다면:

```bash
gbrain embed --stale
gbrain health
```

embedding coverage가 올라가야 정상입니다.

---

## 12. local/offline 모드에서 아직 지원하지 않는 것

아래는 아직 managed/Postgres 쪽 기능입니다.

- HTTP 기반 remote MCP
- 클라우드 파일/스토리지 워크플로우 (`gbrain files ...`)
- Supabase admin / deploy helper

local/offline 모드에서는 이런 기능이 “되는 척”하지 않고, 명확하게 unsupported 안내를 주는 것이 정상입니다.

---

## 13. 자주 겪는 문제

### `gbrain init --local`은 됐는데 검색 결과가 없다

아직 import를 안 했을 가능성이 높습니다.

```bash
gbrain import /path/to/brain
gbrain stats
```

### `gbrain embed --stale`가 provider unavailable이라고 나온다

로컬 임베딩 런타임을 아직 설정하지 않은 상태입니다.

다음 중 하나를 설정하세요.

- `GBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST`

그 다음 다시:

```bash
gbrain embed --stale
```

### 터미널에서는 `gbrain serve`가 되는데 MCP client에서는 안 된다

대부분은 클라이언트가 다른 환경/설정 디렉터리를 보고 있기 때문입니다.

해결 방법:

- 기본 `~/.gbrain/config.json` 사용
- 또는 env를 export한 wrapper script를 만들어서 `exec gbrain serve`

### `gbrain files ...`가 local 모드에서 실패한다

현재는 정상입니다.

SQLite local/offline 모드에서는 클라우드 파일/스토리지 워크플로우가 아직 지원되지 않습니다.

---

## 14. 바로 시작용 최소 명령 요약

```bash
bun add -g github:meghendra6/gbrain
gbrain init --local
gbrain import ~/git/brain
gbrain query "내 노트에 있는 문장"
codex mcp add gbrain -- gbrain serve
```
