# MBrain 코드베이스 종합 리뷰 — 2026-06-11

> Full-codebase architecture + gap review of MBrain v0.13.0. Written in Korean.
> Self-contained: a future session can act on any finding below without
> re-running the analysis.

- **기준 커밋:** `master` `169ece15` (v0.13.0), PR #176(`worktree-f7-engine-dedup`) 머지 직전
- **분석 방법:** 서브시스템별 병렬 코드 탐사 6트랙(코어 계약/엔진, 검색/파생, 메모리 거버넌스, 에이전트 세션 메모리, 전송/표면, 품질 인프라) + 내부 문서(`docs/architecture/redesign/`, `docs/performance-review-2026-06-10.md`, `TODOS.md`, ethos) + MBrain 브레인 페이지(`personal/mbrain/*`) 교차 검증
- **연관 기록:** Memory Inbox 후보 `3a034556-3be9-4c30-b12c-84033495fa6d` (이 리뷰 요약, 리뷰 대기)
- **2차 추가 (같은 날):** Part 5 — 6관점(제품/경쟁, 급진 아키텍처, 에이전트 인체공학, 검색 과학, 운영 회의론, 삭제주의) 병렬 브레인스토밍을 발산시킨 뒤 본 세션이 타당성을 선별한 방향성 아이디어. Part 2(G1–G10)가 "현재 코드의 결함"이라면 Part 5는 "제품을 최고로 만들기 위한 보완·구조 변경 아이디어"다.
- **사용법:** 각 항목(G1~G10)은 "현상 → 증거 → 왜 문제인가 → 개선 방안 → 검증" 구조다. 항목 하나를 골라 그대로 작업을 시작하면 된다. 줄 번호는 기준 커밋 기준이므로 어긋날 수 있다 — 심볼명으로 재탐색하라.

---

## Part 1. 시스템 이해 (재분석 불필요 수준 요약)

### 목표

MBrain은 **한 사람과 그의 로컬 AI 에이전트를 위한 Postgres+pgvector 개인 기억 런타임**이다.
핵심 가치는 *compounding context* — 에이전트가 한 번 배운 것을 다음 세션에서 재발견하지
않게 하는 것. `docs/architecture/redesign/00-principles-and-invariants.md`가 헌법 역할:

1. 사람이 편집 가능한 Markdown이 캐논(canonical truth)
2. 파생 산출물은 삭제·재생성 가능해야 하며, 명시적 승격 없이 캐논이 될 수 없음
3. 승격된 지식은 출처(provenance) 필수
4. 업무/개인 메모리 기본 격리 (스코프 게이트)
5. 백엔드 간 계약 수준 동등성 (Postgres/PGlite/SQLite)
6. 재작성 금지, 점진 진화

### 구조 (레이어)

| 레이어 | 위치 | 규모/핵심 |
|---|---|---|
| 계약(Contract) | `src/core/operations.ts` + 11개 `operations-*.ts` | **~195개 오퍼레이션** 단일 정의 → CLI/stdio MCP/HTTP MCP/Edge 모두 여기서 생성 |
| 엔진 | `src/core/engine.ts` (BrainEngine, **129 메서드**, 8개 능력 인터페이스 합성) | Postgres(4,190줄)·PGlite(4,161줄)·SQLite(8,528줄). PR #176이 PG 계열을 `pg-engine-base.ts`로 통합 |
| 스키마 | `src/schema.sql` + `src/core/migrate.ts` (3,225줄) | 마이그레이션 v1–v52 |
| 메모리 5계층 | — | 캐논(페이지/프로필/에피소드) → 파생(청크/노트 매니페스트/컨텍스트 맵·아틀라스) → 워킹(Memory Inbox 후보/태스크 스레드/트레이스) → 감사(변이 원장/핸드오프/모순) → 컨트롤플레인(렐름/세션/그랜트) |
| 검색 | `src/core/search/` + `services/retrieve-context-service.ts` | 키워드+벡터 RRF(K=60), 4단계 dedup, 소스 가중치 30+규칙, 위키링크/그래프 프런티어 확장 |
| 거버넌스 | `operations-memory-inbox.ts`(2,543줄), `auto-promote/`, `maintenance/` | 신호 → `route_memory_writeback` → 후보 → 리뷰/auto-promote → 캐논 쓰기. `put_page`는 content-hash로 stale write 차단 |
| 전송 | `src/mcp/server.ts`(stdio), `src/mcp/http-server.ts`+`oauth.ts`(HTTP+OAuth 2.1 DCR/PKCE), `supabase/functions/mbrain-mcp/`(Edge) | 동일 계약, 다른 транспорт |
| 스킬 | `skills/` 9종 (fat markdown) | thin harness, fat skills 철학 (`docs/ethos/`) |

### 동작 (brain-agent loop)

읽기: `retrieve_context`(탐침, 후보+read_plan 반환) → `read_context`(증거 경계; 사실 답변의
근거는 여기서만) → `search`/`query`/`get_page`. 쓰기: `route_memory_writeback`이
direct_user_statement/source_extracted + 명확한 타깃이면 `canonical_write_allowed`,
추론/모호/모순이면 `create_candidate`(Memory Inbox), 아니면 defer/no_write.

테스트: 유닛 ~322파일 + 시나리오 34개 + E2E Tier-1(기계적, DB만)/Tier-2(LLM, nightly).
소스:테스트 ≈ 1:1 (각 ~10만 줄).

---

## Part 2. 발견 사항 (우선순위순)

### G1. 거버넌스 기계가 "꺼져 있음" — 목표와 기본 동작의 최대 간극 (구조, HIGH)

**현상:** auto-promote, dream cycle, lifecycle forgetting, 모순 해소가 모두 정교하게
구현되어 있으나 전부 opt-in/수동 호출이라 기본 에이전트 루프에서 한 번도 돌지 않는다.
후보(Memory Inbox)는 쌓이기만 하고, 백로그가 커져도 알려주는 경로가 없다.

**증거:**
- auto-promote 기본 off: `src/core/auto-promote/config.ts:27` (`enabled: false`), CLI 전용 진입 `src/commands/auto-promote.ts:28-72` (config 게이트 :37-40)
- dream cycle: `--apply-auto-promote`, `--allow-canonical-page-writes` 기본 false; 스케줄러 없음
- lifecycle forgetting: `src/core/maintenance/lifecycle-forgetting.ts:34-71`에 purge/archive/restore 정책 정의만, 트리거 부재
- 백로그 관측만 존재: `brain-loop-audit-service.ts:135` (`review_priority_candidate_count`), `memory-report.ts:34-50` — 에스컬레이션·알림 없음
- patch 후보는 게이트가 스킵: `src/core/auto-promote/promote-gate.ts:47` (`proposed_patch → skipped`, "not yet supported")
- 변이 원장 retention 정책 없음: `operations-memory-mutation-ledger.ts` (907줄) — 무한 증가
- assertion 파이프라인(`src/core/assertions/` 6파일)이 Memory Inbox와 단절: 후보가 assertion을 참조하지 않고, assertion이 후보를 만들지 않음

**왜 문제인가:** 제품 목표가 "compounding context"인데, 축적(capture)만 자동이고
정제(review→promote→canonical)는 전부 수동이다. 사용하지 않으면 후보 백로그는
조용히 무한 증가하고, 정교한 거버넌스 코드 4,200줄+이 사실상 데드 패스가 된다.

**개선 방안:**
1. **최소 자율 루프(기본 on, 안전)**: dream cycle을 candidate_only 모드(캐논 쓰기 금지)로 주기 실행하는 스케줄 등록을 `setup-agent`/`init`에 포함. 기존 `mbrain dream` + cron-schedule 가이드(`docs/guides/cron-schedule.md`) 재사용.
2. **백로그 압력 표면화**: `staged_for_review` 수가 임계치(예: 50) 초과 시 `mbrain doctor`와 daily memory report 최상단에 경고 섹션 강제 출력. `brain-loop-audit-service`의 압력 메트릭을 재사용하면 신규 계산 불필요.
3. **auto-promote 리뷰 다이제스트**: dry-run을 주기 실행해 "승격 가능 N건 / 모순 M건" 다이제스트를 report로 저장 → 사용자는 `--apply`만 결정.
4. **원장 retention**: `memory_mutation_events`에 보존 기간(예: 180일) + dream phase에서 정리. 감사 요건상 삭제 대신 아카이브 테이블도 고려.
5. **patch 승격 지원 완성** 또는 patch 상태머신(`types/memory-governance.ts:373-380`) 축소 — 현재는 정의만 있고 게이트가 거부.

**검증:** 시나리오 테스트(s33 패턴)로 "후보 50개 누적 → doctor 경고 → dream candidate_only 실행 → 다이제스트 생성" 루프를 E2E로.

### G2. 에이전트 세션 캡처가 수동 — 연속 학습 루프 미완성 (구조, HIGH)

**현상:** 세션 메모리 서브시스템(압축→분류→캡처→활성화)은 완성도가 높으나,
실제 세션 종료 시 트랜스크립트를 자동으로 캡처하는 훅이 없다.

**증거:**
- stop hook은 로그만 남김: `src/commands/setup-agent-hook-assets.ts:79-147` (기본 MODE=silent, 로그 `~/.claude/logs/mbrain-stop-hook.log` :94) — `capture_agent_session_memory`를 호출하지 않음
- 캡처는 수동 CLI 전용: `src/commands/agent-session.ts:25-54` (JSON 파일을 직접 만들어 넘겨야 함)
- 테스트도 핸들러 직접 호출: `test/scenarios/s33-agent-session-memory-loop.test.ts:31,69`

**왜 문제인가:** "에이전트가 배운 것을 다음 세션이 기억한다"는 가치가 사용자가
수동으로 export할 때만 작동한다. 사실상 아무도 안 하게 되는 경로다.

**개선 방안:**
1. Claude Code Stop hook이 받는 `transcript_path`(JSONL)를 캡처 엔벌로프로 변환하는 어댑터를 `agent-session-capture-envelope-service.ts`에 추가 (이미 hook-friendly JSON/JSONL 정규화가 존재 — 입력 포맷만 추가).
2. stop hook 스크립트에 opt-in 모드 `MBRAIN_STOP_HOOK_MODE=capture` 추가: 백그라운드로 `mbrain agent-session capture --file <transcript> --apply` 실행 (기본 write_mode는 이미 candidate_only라 안전).
3. `setup-agent --apply`에 캡처 모드 선택 프롬프트 추가, `doctor --agent`가 캡처 훅 상태 검증.

**주의(연계 발견 G10):** prompt-injection 플래그가 붙은 신호도 후보로 들어간다
(`agent-session-writeback-service.ts:147-150`). 자동 캡처를 켜기 전에 injection-flagged
신호는 기본 suppressed + 강제 review_reason으로 막아야 한다.

### G3. MCP 툴 표면 비대 — 195개 툴 무페이지네이션 노출 (UX/비용, HIGH)

**현상:** 모든 오퍼레이션이 MCP 툴로 노출된다. `list_tools`가 195개 전체를 반환.

**증거:** `src/mcp/server.ts:681-685` (전체 배열 반환, 커서 없음). 컴팩트 모드
(`MBRAIN_MCP_COMPACT_TOOL_SCHEMAS`, 기본 on)는 스키마 메타데이터만 줄이고 개수는 못 줄임.

**왜 문제인가:** 에이전트 일상 루프에 필요한 건 10~15개(retrieve/read/search/query/
get_page/put_page/route_memory_writeback/sync_brain 등)뿐. 나머지 180개는 클라이언트
컨텍스트 비용 + 툴 선택 정확도 저하를 유발한다. (deferred-tool 로딩을 지원하지 않는
MCP 클라이언트에서 특히 비쌈.)

**개선 방안:**
1. operation 정의에 `tier: 'core' | 'extended'` 필드 추가 (`operations.ts`의 Operation 타입).
2. stdio/HTTP 서버가 기본 core만 노출, `MBRAIN_MCP_TOOL_TIER=all`로 전체. Edge는 현행 유지.
3. core 셋 선정 근거: `mcp_request_log`(HTTP) + stdio 호출 카운터를 잠깐 수집해 상위 사용 빈도로 결정. 1차 추정: retrieve_context, read_context, search, query, get_page, put_page, route_memory_writeback, sync_brain, get_skillpack, capture/preview_agent_session_memory, list/advance/promote/reject memory candidates, get_stats/get_health.
4. extended 접근은 `get_skillpack` 안내문에 "전체 툴은 TIER=all" 명시.

**검증:** `test/parity.test.ts`에 tier 메타데이터 계약 테스트 추가; MCP 클라이언트로 core 노출 수 확인.

### G4. 검색 품질 — 다음 단계 부재 + 핫스팟 (품질/성능, MEDIUM-HIGH)

**현상/증거:**
- 리랭커 없음, 최신성(recency) 부스트 없음 — 모든 청크가 시간 무관 동일 가중
- 쿼리 확장 비일관: `expandQuery()`는 `hybrid.ts`에서만 사용, `retrieve_context`는 자체 토크나이즈(`retrieve-context-service.ts:561-581`)
- 링크 후보 N+1: `retrieve-context-service.ts:827` (시드별 `getPageProjection` 순차 호출, 5시드×4링크=20회)
- 매니페스트 백링크 풀스캔: `retrieve-context-service.ts:851-882` (시드별 백링크 4개 찾을 때까지 무캡 스캔)
- 임베딩 없는 후보 무음 탈락: `search/vector-local.ts:35` (flatMap이 null 임베딩 제거 — 커버리지 저하를 에이전트가 모름)
- dedup 순서 문제: `dedup.ts:144-179` (`guaranteeCompiledTruth`가 per-page cap 이후 실행 → 하위 랭크 청크 승격 가능)
- freshness 표현 3종 불일치: `SearchResult.stale`(1bit) vs `RetrievalSelector.freshness` vs `derived_status`(4상태) — 변환 규칙 없음
- `retrieve-context-service.ts` 1,513줄 모놀리스 (40+ 헬퍼 상호의존)

**개선 방안 (단계별, 독립 실행 가능):**
1. **기계적 수정부터**: 링크 후보 projection을 slug 배열 단일 쿼리로 배치화; 백링크 스캔에 상한(예: 매니페스트 500행) + 결과 부족 시 조기 종료.
2. **expansion 일원화**: `retrieve_context`도 `expandQuery()` 경유 (플래그로 보호, 평가 픽스처로 회귀 확인 — `docs/benchmarks/phase1` + 0.12의 graph frontier 평가 게이트 패턴 재사용).
3. **freshness 단일화**: `derived_status` 4상태를 진실로 두고 나머지 둘은 그로부터 파생하는 변환 함수 하나로 통일.
4. **recency boost 실험**: RRF 융합 후 `updated_at` 기반 감쇠(예: half-life 180일)를 옵션으로; 평가 픽스처로 recall/precision 비교 후 기본화 결정.
5. **서비스 분해**: candidate-discovery / graph-augmentation / ranking / freshness 4모듈로 — 랭킹 실험을 위한 전제조건.
6. (장기) 로컬 cross-encoder 리랭크 옵션 — 로컬 임베딩 런타임(`embedding/provider.ts`)과 같은 패턴으로.

### G5. 계약/타입 부채 — F8 외 (유지보수, MEDIUM, 기계적)

**현상/증거:**
- **F8 (perf review 미해결분)**: `requiredString`/`optionalString`/`optionalBoolean`/`optionalNumber`/`requiredObject`/`optionalObject` + `OperationErrorCtor`가 4파일에 동일 복제 (400+줄): `operations-source-registry.ts:2455-2540`, `operations-memory-mutation-ledger.ts:166-307`, `operations-memory-control-plane.ts:66-126`, `operations-assertions.ts:237-267`
- 핸들러 반환 `Promise<unknown>` + `operations.ts`에 `as any` 107곳 (결과 내로잉)
- 엔진 행 변환 무검증 캐스트 ~90곳 (`rows[0] as Record<string, unknown>` 패턴) — SELECT 컬럼 누락 시 무음 변형
- `BrainEngine` 129 메서드 — MemoryGovernanceStore만 25개, 하위 인터페이스 미분리
- biome 약함: `noUnusedImports`/`noUnusedVariables` warn만 (biome.json)
- 미완 TODO: `operations.ts:6002` "generate signed URL from Supabase Storage"

**개선 방안:**
1. `src/core/operations-param-utils.ts`로 검증 헬퍼 추출 (PR #176 직후 하기 좋은 기계적 작업; 동작 불변, diff만 큼).
2. 응답 envelope 판별 유니온 도입은 점진적으로 — 신규/변경 오퍼레이션부터.
3. 행 변환에 경량 런타임 가드(필수 컬럼 존재 체크) — Zod 풀도입보다 비용 대비 효과적.
4. biome에 `noExplicitAny: warn` 추가 후 신규 코드만 단속.

### G6. HTTP/OAuth 보안 마감 4건 (보안, MEDIUM-HIGH — 외부 노출 전 필수)

**현상/증거:** 기초는 좋음(PKCE S256 강제 `oauth.ts:372-373`, timing-safe 비교 :440-443,
토큰 SHA-256 저장, refresh 토큰 바인딩 :323-336). 그러나:
1. CORS 와일드카드: `http-server.ts:569` (`Access-Control-Allow-Origin: *`)
2. rate limit 부재: token/authorize 엔드포인트 무제한 (DCR pending만 128 캡)
3. 요청 로깅 기본 no-op: `http-server.ts:47` (`logRequest` 옵션) — `mcp_request_log` 테이블은 있으나 기본 미사용
4. secret 폴백: `serve.ts:34-36` — `MBRAIN_OAUTH_SIGNING_SECRET` 없으면 approval token이 서명 키 겸용

**개선 방안:** (1) `--public-url` 기반 origin 허용 목록(미설정 시 CORS 헤더 자체 생략);
(2) 토큰/인가 엔드포인트에 인메모리 토큰버킷(예: IP당 10req/min — 단일 사용자 서버라 충분);
(3) `mcp_request_log` 기록을 기본 on (성능 영향 미미, 단일 사용자); (4) OAuth 활성화 시
두 secret 모두 요구하고 폴백 제거 (마이그레이션 노트 필요 — `skills/migrations/` 패턴).

### G7. 커넥터 약속 vs 현실 (정직성, MEDIUM)

**현상/증거:** `src/core/connectors/connector-registry.ts`에 11종 정의(email, calendar,
slack, discord, pdf, bookmarks…), `connector-sync.ts`는 스텁. 실동작은 git 기반
`sync`(`src/commands/sync.ts`)와 일회성 `import` 둘뿐. source registry는 수동 등록만.

**개선 방안:** 둘 중 하나를 명시적으로: (a) 가장 가치 높은 1개(회의 워크플로와 연결되는
calendar/meeting ingest)를 실제 구현, 또는 (b) 레지스트리에 `status: 'planned' | 'available'`
필드를 추가해 doctor/docs/README에서 정직하게 노출하고 스캐폴딩임을 표시.
redesign 원칙("정직한 능력 보고", offline-profile의 honest gating 패턴)과 일치시키는 것.

### G8. CI 플랫폼 공백 — macOS 미테스트, smoke 미편입 (인프라, MEDIUM, 저비용)

**현상/증거:**
- `test.yml`은 ubuntu 전용 (gitleaks + typecheck + 4샤드 + postgres-jsonb). release.yml만 macOS에서 빌드하고 테스트는 안 돌림.
- 최근 macOS 사후 패치 3건: `06b17e92`, `4f8d7c8c`, `00ad993f` (전부 "stabilize macOS PGLite") — 릴리스 후에야 발견되는 패턴.
- `bun run smoke:postgres-runtime`, `smoke:http-oauth`가 CI에 없음 (로컬 전용).
- Tier-2(LLM)는 nightly만 — LLM 관련 PR이 머지 전 검증 안 됨 (비용 문제라 의도적; PR 라벨 기반 opt-in 트리거가 절충안).

**개선 방안:** test.yml에 macOS PGLite 샤드 1개 추가(전체 매트릭스 불필요);
release.yml pre-publish에 smoke 2종 편입; `claude-code` 라벨식 opt-in Tier-2 트리거.
참고: 이번 PR #176의 jsonb 회귀를 잡은 것이 바로 `postgres-jsonb` CI 잡이다 —
엔진 경계 전용 회귀 테스트의 가치가 입증됨. PGlite/SQLite에도 동급의 jsonb-typeof
검증 테스트를 추가할 것.

### G9. 브레인 자체 드리프트 — 도그푸딩에서 드러난 제품 갭 (메타, MEDIUM)

**현상/증거:** MBrain 지식베이스의 `personal/mbrain/*` 페이지 18개(architecture,
memory-architecture, retrieval, data-model, cli-reference, setup-and-profiles 등)가
전부 v0.11.0 / commit `a962bbd` (2026-06-02 작성) 기준. v0.12(graph frontier,
agent-trust)·v0.13(stop hook 개편) 변화가 반영 안 됨. 릴리스 시 브레인 페이지를
재동기화하는 루프가 없다.

**왜 문제인가:** "에이전트가 브레인을 먼저 읽는다"는 제품 루프에서, 브레인이 낡으면
에이전트가 낡은 사실을 자신 있게 인용한다. 이것은 사용자 개인 문제가 아니라
**제품이 staleness를 감지·표면화하지 못하는 갭**이다.

**개선 방안:** (1) 페이지 frontmatter의 `source_commit`/`source_version`과 현재 설치
버전을 비교하는 staleness 체크를 `mbrain report`/doctor에 추가 (frontmatter는 이미
존재 — 비교만 하면 됨); (2) `/document-release` 체크리스트에 "codemap-ingest로
관련 브레인 페이지 갱신" 단계 추가; (3) 갱신 자체는 기존 `skills/codemap-ingest` 워크플로 재사용.

### G10. 세션 분류기(zero-LLM) 품질 한계 (품질, LOW-MEDIUM — 알고 관리)

**현상/증거:** (`src/core/services/agent-session-classifier-service.ts`)
- 부정문 미처리: "I don't prefer X"가 선호로 오탐 (:274 정규식)
- task mechanics 화이트리스트가 5개 명령뿐 (:243-262) — 신규 도구는 신호로 누출
- prompt-injection 플래그 신호도 후보 유입 (`agent-session-writeback-service.ts:147-150`)
- 활성화 시 의미 dedup 없음 (`agent-session-activation-planner-service.ts:39-44`, 단순 substring 매칭 :143-150)
- 세션이 해결한 task와 `task_id` 연계 부재 — task 종결이 일반 project note로 캡처됨

**개선 방안:** 자동 캡처(G2) 전제조건으로 injection-flagged 기본 suppressed부터.
이후 negation 패턴, mechanics 휴리스틱 보강(명령 패턴 외 엔트로피/구조 기반),
활성화 dedup, task_id 추출 순. 분류 정확도가 중요해지면 auto-promote처럼
judge-only LLM 옵션 추가(결정론 기본 유지).

---

## Part 3. 이미 진행/완료된 개선 (중복 작업 방지)

`docs/performance-review-2026-06-10.md` 기준:

- **완료 (perf waves):** F1(MCP 핫패스 O(n) 디스패치+config 재읽기), F2(하이브리드 검색 직렬화), F3(노트 섹션 N+1), F4(SQLite 청크 커밋), F5(SQLite 벡터 이중 스캔), F6(키워드 검색 per-row tsvector), F9(벌크 루프 config), F10(파생 상태 라운드트립), F13(마이그레이션 루프)
- **F7 (엔진 중복):** PR #176 (`worktree-f7-engine-dedup`)로 해결, **2026-06-11 master에 squash 머지됨 (`9fa99a43`)** — `postgres-engine.ts`/`pglite-engine.ts`의 공유 SQL을 `src/core/pg-engine-base.ts`로 추출 (+4,183/−8,052). 트랜스포트 심: `PgQueryable.query(text, params)`, `execRaw`, `txq`, `withSearchTimeout`, `onChunksChanged` 훅.
  - **⚠️ 머지 과정에서 잡힌 회귀 (미래 세션 필독):** postgres.js(npm `postgres`)는 `sql.unsafe(text, params)`에서 서버가 기술(describe)한 파라미터 타입이 json/jsonb(OID 114/3802)이면 **자체 직렬화기(JSON.stringify)를 또 적용**한다. 베이스 클래스 규약이 "JSON 파라미터는 항상 미리 `JSON.stringify` + SQL에서 `::jsonb` 캐스트"이므로, 문자열이 이중 인코딩되어 jsonb **string scalar**로 저장됐다 (`jsonb_typeof` = 'string'). 수정: `postgres-engine.ts`의 `connect()` 드라이버 옵션에서 json 타입 직렬화기를 "문자열이면 통과, 객체면 stringify"로 오버라이드. 이 함정은 `test/postgres-jsonb-engine.test.ts`가 잡았다 — **PG 계열 엔진의 SQL/직렬화를 만질 때는 반드시 이 테스트를 Postgres에 대해 돌려라.** PGlite는 자체 드라이버가 재직렬화하지 않아 영향 없음.
- **미해결 perf 항목:** F8(검증 헬퍼 중복 → G5-1), F11(태그 reconcile 직렬), F12(auto-promote 순차 judge), F14+(perf review 문서 후반 참조)

---

## Part 4. 권장 실행 순서

| 순서 | 항목 | 근거 |
|---|---|---|
| 1 | G5-1 (F8 param-utils 추출) | PR #176 직후 기계적·저위험, 워밍업 |
| 2 | G8 (CI macOS 샤드 + smoke 편입 + PGlite/SQLite jsonb 테스트) | 저비용, 릴리스 사고 예방, 이번 회귀로 가치 입증 |
| 3 | G1 (최소 자율 루프: candidate_only dream 스케줄 + 백로그 표면화) | 제품 가치 최대 |
| 4 | G10-선행 + G2 (injection suppressed → 자동 캡처 훅) | G1과 함께 "compounding" 루프 완성 |
| 5 | G6 (OAuth 보안 마감 4건) | 외부(ChatGPT 등) 노출 확대 전 필수 |
| 6 | G4-1~3 (검색 기계적 수정 + expansion 일원화 + freshness 통일) | 평가 픽스처 있어 안전 |
| 7 | G3 (툴 티어링) | 사용 빈도 데이터 수집 후 |
| 8 | G9 (브레인 staleness 체크 + 릴리스 연동) | 도그푸딩 품질 |
| 9 | G7, G4-4~6, G5-2~4, G10-후속 | 점진 |

---

## Part 5. 방향성 브레인스토밍 — 발산 후 선별 (2026-06-11)

6관점 서브에이전트(제품/경쟁·급진 아키텍처·에이전트 인체공학·검색 과학·운영 회의론·삭제주의)로
발산한 아이디어를 본 세션이 선별했다. **채택 권고(5.1) / 전략적 베팅(5.2) / 기각·보류(5.3) /
열린 질문(5.4)**로 나눈다. 각 항목은 자립적으로 착수 가능하게 기술한다.

### 5.1 채택 권고 (근거 강함, 점진 구현 가능)

#### 제품 루프 가시화 — "컴파운딩이 보여야 가치다"

- **P1. "Today I Learned" 세션 디프 (최우선)** — 세션 종료 훅이 캡처 파이프라인(존재함)을 거쳐
  사람이 읽는 디프를 출력: "오늘 배운 것: (a) X 선호 [승격], (b) Z 마감 변경 [후보 — 리뷰?],
  모순 2건 대기". 같은 내용을 `brain/journal/` 일일 페이지로 적재. G1·G2 개선과 같은 작업의
  사용자-가시면이다. 경쟁사 claude-mem이 "보이는 기억"만으로 마인드셰어를 얻는 것이 근거.
  [INCREMENTAL — capture/classify/route 서비스 재사용, 훅+렌더링만 신규]
- **P2. Morning Brief 일급 명령** — `mbrain brief`: 미팅 준비(엔티티 페이지), 스테일 스레드,
  Inbox 트리아지 카드(승격/기각/스누즈 원키), 이번 주 감쇠한 기억. dream cycle 산출물이 이미
  대부분의 입력을 계산한다 — 운영 배관을 의식(ritual)으로 승격하는 일. 2026 플랫폼 방향
  (OpenAI Dreaming, 사전 제안형 메모리)과 일치. [INCREMENTAL→일부 LLM 합성]
- **P3. Memory Report Card (온보딩 wow)** — `mbrain import` 직후 1페이지 리포트: 페이지/인물/
  모순/무출처 수, 상위 클러스터. 공유 가능한 스크린샷 순간. [INCREMENTAL]
- **P4. Audited Answers** — `mbrain why "<claim>"` + `query --audited`: assertion→source→timeline
  체인 워크. `explain_assertion`이 이미 존재 — 아키텍처 자산의 제품화. "교차심문 가능한 기억"은
  mem0/Letta가 단기간에 못 베끼는 차별화. [INCREMENTAL]
- **P5. Memory Passport** — 버전드 export 번들(마크다운 + JSONL assertion + 프로필, 가시성 존중)
  + ChatGPT 메모리/mem0/basic-memory 임포터. 2026 락인 흐름에서 "출구 보장"은 가장 날카로운
  OSS 포지셔닝이자 성장 채널. 운영 관점의 full-export(O 항목)와 동일 기반. [INCREMENTAL/임포터별]

#### 에이전트 프로토콜 — 규율(프롬프트)이 아니라 구조로 강제

- **E1. `recall` / `remember` 복합 툴 (최우선)** — `recall(question)`이 내부에서
  probe→read→cite를 오케스트레이션해 `{canonical_reads, citations}`만 반환; `remember(content,
  target, reason)`은 라우터 프리플라이트를 강제. 에이전트가 증거 경계를 건너뛸 수 없게 된다.
  G3(툴 티어링)의 상위 해법 — 코어 표면이 자연스럽게 ~10개로 준다. [STRUCTURAL이나 기존 서비스
  조합; 기존 툴은 extended 티어로 유지]
- **E2. 세션 부트스트랩/구조적 종료** — `bootstrap_agent_session()`(열린 태스크 + 최근 에피소드
  + 활성화 팩 + 권위 라벨 반환; `plan_agent_session_activation` 재사용)과
  `close_agent_session(log, write_plan)`(변이 적용 + 스테일 페이지 + 유지보수 플래그 반환).
  스톱 훅의 잔소리를 프로토콜로 대체. G2 자동 캡처의 자연스러운 그릇. [STRUCTURAL]
- **E3. Working-Context 단일 엔드포인트** — `get_working_context(question, token_budget)`:
  멀티 리드 컴파일 + 권위 랭킹 + 토큰 카운팅을 서버가 수행, 에이전트는 1콜. [INCREMENTAL]
- **E4. 위생·신뢰 피드백 묶음** — read 결과에 `hygiene_report`(스테일 페이지/퍼지 후보/커넥터
  이슈) 블록; 오퍼레이션 스키마에서 에이전트 문서(CLAUDE/AGENTS 섹션) 자동 생성; retrieve→write
  프로토콜 준수율(trust score)을 세션 메타데이터로 — v0.12 agent-trust 게이트의 연장. [INCREMENTAL]

#### 검색 품질 — 평가 하네스 먼저, 그다음 SOTA

- **R1. MBrain-native LongMemEval 하네스 (최우선·게이트)** — LongMemEval 5유형(단일/다중 세션,
  시간 추론, 지식 갱신, 기권)을 픽스처 브레인 기반 결정론적 질문 스위트로; 기권(abstention)은
  read_context의 "캐논 증거 부재" 규칙과 직결. v0.12 graph-frontier 검증 게이트 패턴 재사용.
  이것이 없으면 아래 전부가 의견에 불과하다. 제품 아이디어 "Memory Score"(자기 브레인 채점,
  Zep식 벤치마크 마케팅 대응)와 같은 기반. [INCREMENTAL]
- **R2. 결정론적 컨텍스추얼 청크 임베딩** — 임베딩 전 청크에 템플릿 헤더(페이지 제목/타입/존/
  섹션 경로/타임라인 날짜, ~150자 캡) 전치. Anthropic Contextual Retrieval의 무LLM 변형 —
  로컬 우선·결정론 제약 충족, `chunk_content_hash`가 캐시 무효화 제공. 컨텍스트 없이 임베딩되는
  타임라인 청크("She agreed to the terms")의 리콜을 크게 개선. [INCREMENTAL, 전체 재임베딩 1회]
- **R3. 로컬 late-interaction 리랭커 (플래그 게이트)** — answerai-colbert-small급 모델로
  `rrfFusion`과 `dedupResults` 사이에 MaxSim 삽입; 청크 토큰 임베딩을 `chunk_content_hash` 키로
  영속해 쿼리 시 인코딩 1회. 부수효과로 dedup의 Jaccard 근사도 대체. 실패 시 현행 휴리스틱
  폴백. [INCREMENTAL]
- **R4. Bi-temporal as-of 검색** — `assertions.valid_from/valid_until`+supersession 체인이 이미
  존재(스키마 80% 완성). `plan_retrieval_request`에 `as_of` 추가, 기본적으로 superseded 제외,
  모순 해소가 엣지 무효화(valid_until)를 기록. "3월에는 뭐가 사실이었나"류 질의는 벡터 검색이
  범주적으로 못 푸는 영역. [검색측 INCREMENTAL]
- **R5. Sleep-time 통합 dream phase** — 고변동 페이지의 compiled-truth 재작성 제안(put_page
  거버넌스 경유) + 질문형 패러프레이즈를 `anticipated_query` 청크로 임베딩(질문↔서술 임베딩
  미스매치 해소). auto_promote phase 패턴 그대로(게이트, dry-run 기본). [INCREMENTAL]
- **R6. Ebbinghaus 안정성 점수** — `retrieval_traces`에서 페이지별 안정성 S(검색마다 성장),
  R=exp(−Δt/S)를 (a) source-ranking에 bounded 승수(0.9–1.1), (b) lifecycle purge 후보 랭킹
  입력으로. 생성시점 부스트와 달리 사용 기반·결정론적. dream-cycle 읽기는 카운트 제외(부익부
  방지). [INCREMENTAL]
- **R7. Confidence-gated iterative deepening** — RRF 1위~k위 점수 갭이 임계 미만이면
  `traverse_graph` 1-hop 확장 후 동일 RRF 재융합(결정론 게이트). 멀티홉/멀티세션 리콜 —
  LongMemEval 최난 카테고리 대응. [INCREMENTAL]
- **R8. Lazy atlas refresh** — 사전 전체 재빌드 대신 broad-synthesis 시점에 links 프런티어
  확장 + 터치된 커뮤니티만 derived_jobs 갱신(LazyGraphRAG 방식). S4(atlas/map 통합)와 함께 적용.
  [INCREMENTAL]

#### 운영 내구성 — "10년 운영" 이야기의 구멍 메우기

- **O1. `mbrain backup` / `mbrain restore` (최우선)** — 현재 백업 자동화가 **전무**하다.
  pg_dump + 마크다운 repo + config 스냅샷/복원 명령, doctor에 백업 나이 경고, 주간 크론 런북.
  단일 최대 사고 모드 제거. [INCREMENTAL, 1–2일]
- **O2. DB 재구성 가능성 검증 + 정직 공시 (최우선)** — "DB는 파생, 마크다운이 진실" 주장에는
  구멍이 있다: Memory Inbox·태스크 스레드·에피소드·변이 원장은 **DB에만** 산다. (1) export→
  wipe→재수화→체크섬 검증을 수용 게이트로, (2) doctor에 "마크다운에 없는 상태" 데이터 손실
  경고 명시, (3) `export --full`(운영 메모리 포함 JSON) 추가 — P5 passport와 동일 작업.
  [STRUCTURAL 감사 + INCREMENTAL export]
- **O3. 멀티 디바이스 충돌 감지** — 두 랩탑 시나리오에서 현재 last-write-wins 무경고. 콘텐츠
  해시 비교로 감지+경고 먼저(머지는 다음 단계). [INCREMENTAL]
- **O4. 업그레이드 프리플라이트 + 마이그레이션 전 자동 스냅샷** — 52개 마이그레이션, 중간 실패
  시 반파 상태 복구 경로 없음. `check-update --preflight`(스키마 디프 드라이런) + 마이그레이션
  전 자동 백업(O1 의존) + `rollback-migration`. [INCREMENTAL]
- **O5. 헬스 비컨** — sync/embed 성공마다 `.mbrain/health.json` 갱신; doctor/stats가 "마지막
  성공 동기화 N일 전", "임베딩 없는 청크 N개" 표면화. 감시자가 조용히 죽는 문제(현재 5연속
  실패 후 무음 종료) 해결. G1의 백로그 표면화와 한 묶음. [INCREMENTAL, 2–3일]

#### 구조 단순화 — 삭제주의 감사 중 채택분

- **S1. SQLite 엔진 단계적 폐기** — 이미 공식 포지션이 legacy. PR #176으로 PG 계열(postgres/
  pglite)은 SQL을 공유하므로, PGLite를 임베디드/트라이얼 엔진으로 유지하고 SQLite(8,528줄,
  최대 단일 파일)를 deprecate→마이그레이션 가이드→제거. CI 매트릭스 2엔진화. [STRUCTURAL,
  Q2(실사용자) 확인 후]
- **S2. BrainEngine capability 모듈화** — 코어 스토어(페이지/태스크/후보/렐름) + 선택 모듈
  (Search/Analysis/EventLog)을 connect-시 CapabilitySet으로 선언; 호출측은 capability 가드.
  offline-profile의 "정직한 능력 게이팅"과 동일 철학의 엔진 내부화. G5(129메서드 비대)의
  구조적 해법. [STRUCTURAL, 점진 4단계]
- **S3. Patch 후보·Redaction Plan: 완성 또는 동결 결정 강제** — patch 상태머신은 정의됐으나
  promote-gate가 스킵(미지원)하는 반제품. 리댁션 플랜도 스킬/레시피 어디서도 안 쓰임. 다음
  릴리스에서 "완성한다(승격 게이트 patch 적용 지원)" 또는 "동결한다(@internal, 오퍼레이션
  제거)"를 결정할 것. 반제품 유지가 최악. [결정 항목]
- **S4. Context Atlas → Context Map 통합 검토** — atlas 서비스는 map 위 얇은 래퍼(엔트리포인트
  추출+예산 힌트+선택 로직)이고 양쪽 모두 같은 소스에서 빌드된다. `query_context_map`에
  `include_entrypoints`/`budget_hint` 옵션을 넣고 atlas 표면(4 ops, 테이블 1개) 제거 검토.
  사용 증거 grep 후 진행. [INCREMENTAL]
- **S5. 문서 단일화** — guides 22편 + SKILLPACK + AGENT_RULES + MCP_INSTRUCTIONS가 같은 패턴을
  중복 서술. 단일 `docs/PRACTICES.md`(또는 생성 문서)로 통합, 스킬은 링크. E4의 문서 자동
  생성과 한 묶음. [INCREMENTAL]
- **S6. Mutation ledger retention** — G1-4 재확인: 90–180일 보존 + dry-run/거부 이벤트 미기록
  + list 기본 limit. [INCREMENTAL]

### 5.2 전략적 베팅 (타당하나 별도 의사결정 필요한 큰 구조 변경)

- **B1. 이벤트 소스 단일 쓰기 경로 + 프로벤넌스 그래프** — 모든 변이를 단일 이벤트 로그로,
  캐논/파생/감사를 프로젝션으로; SourceRecord/RetrievalTrace/후보 supersession을 하나의
  프로벤넌스 그래프로 통합. Inbox↔원장↔트레이스 드리프트를 원천 제거하는 **장기 북극성**.
  선행 단계는 S6(원장 정리)과 assertion↔Inbox 배선(G1)이며, 이 둘의 결과를 보고 착수 여부 결정.
- **B2. 리소스 알지브라** — 195 ops를 ~8 verbs(events/projections/queries/governance) + 별칭
  레이어로 수렴. 내부 개발 속도 5x 주장에 동의하나, 에이전트 측은 E1(recall/remember)로 먼저
  수렴시키고 내부 알지브라는 그 다음. 3릴리스 deprecation 필요.
- **B3. Zero-install 런타임** — 퍼널이 `createdb`에서 죽는다(README 첫 화면이 Postgres 요구).
  옵션 (a) PGLite를 트라이얼 기본으로 + `mbrain upgrade-to-postgres` 승격 경로, (b) embedded
  Postgres 바이너리 번들(`init --standalone`). S1과 정합적인 것은 (a). Q3 결정 필요.
- **B4. `mbrain ui` (로컬 웹뷰)** — Inbox 트리아지(증거 보여주며 승격/기각/대체), 그래프,
  타임라인. 거버넌스 모트를 30초 데모로 만드는 가장 확실한 방법이나 신규 표면 유지비가 크다.
  P1/P2(CLI 의식)로 먼저 검증 후 투자 판단.
- **B5. Cloud/모바일 캡처 티어** — 호스팅 Postgres + 임베딩 크레딧 + 이메일/Shortcuts 캡처
  주소(Inbox 후보로 착지). 지속가능성 옵션; 보안·운영 부담 큼.

### 5.3 기각·보류 (이유 명시)

| 아이디어 | 판정 | 이유 |
|---|---|---|
| 스킬의 실행 계약화(SKILLPACK as code) | 보류 | `docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md`·THIN_HARNESS_FAT_SKILLS 철학과 정면 충돌. 스킬 frontmatter에 기계가 읽는 최소 메타데이터(입력/출력 힌트)까지만 |
| Schema-as-data 마이그레이션 | 기각 | PR #176(PG SQL 단일화) + S1(SQLite 폐기)로 "3중 마이그레이션" 문제 자체가 소멸 |
| HTTP/OAuth 표면 폐기 | 기각 | 직전 릴리스의 의도적 투자(ChatGPT 실연동 검증 완료). 폐기가 아니라 G6 하드닝이 맞음 |
| Memory Realms/세션/그랜트 전면 삭제 | 기각(부분 보류) | 업무/개인 격리는 불변식 — 컨트롤플레인은 그 집행 장치. 단, "게이트가 기본 전부 통과"가 사실이라면 enforced 최소 경로로 단순화할 여지는 있음 → Q1 |
| `mbrain publish` 동결 | 보류 | "사용자 없음"은 추정. 결정론적 도구라 유지비 낮음. 사용 신호 수집 후 재평가 |
| 커넥터 스캐폴딩 삭제 | 부분 채택 | 삭제보다 G7의 `status: planned/available` 정직 노출이 우선. 실 커넥터 1종(미팅/캘린더) 구현이 더 가치 있음 |

### 5.4 열린 제품 질문 (사용자 결정 필요)

- **Q1.** 멀티 에이전트 신뢰 분리(렐름/그랜트 실제 강제)가 로드맵인가, 단일 사용자+신뢰
  에이전트로 고정인가? → 컨트롤플레인 단순화(5.3) 여부 결정
- **Q2.** SQLite 프로필 실사용자가 존재하는가? → S1 폐기 속도 결정
- **Q3.** Zero-install 방향: PGLite 트라이얼 기본(a) vs embedded Postgres 번들(b)?
- **Q4.** 로컬 웹 UI(B4)에 신규 표면 하나를 투자할 가치가 있는가?
- **Q5.** 유료/클라우드 티어(B5) 의지가 있는가?

### 5.5 통합 로드맵 시안 (Part 4와 결합)

- **Phase A (즉시·저위험):** Part 4의 1–2 (F8, CI/macOS) + **O1 백업** + **O5 헬스 비컨**
- **Phase B (제품 루프 완성):** G1 최소 자율 루프 + **P1 TIL 디프** + **E2 부트스트랩/종료**(G2 포함) + **P2 brief**
- **Phase C (평가→검색):** **R1 하네스** → R2 컨텍스추얼 임베딩 → R3 리랭커/R6 안정성 점수 → R4 bi-temporal
- **Phase D (구조 정리):** S3 patch 결정 + S4 atlas 통합 + S1 SQLite 폐기(Q2 후) + S2 capability 모듈 → B2/B1 착수 여부 재평가
- **Phase E (도달 확장):** B3 zero-install(Q3 후) + P3 report card + P5/O2 passport·full export + E1 recall/remember
- E1은 Phase B~C 어디든 앞당길 수 있음 (독립적, 효과 큼)

**참고 출처(요약):** Zep/Graphiti temporal KG (arXiv 2501.13956), Letta sleep-time compute,
LongMemEval (ICLR 2025), Anthropic Contextual Retrieval, Microsoft LazyGraphRAG,
answerai-colbert-small, mem0/basic-memory/claude-mem 경쟁 분석, OpenAI "Dreaming" 메모리.

---

## 부록 A. 규모 지표 (기준 커밋)

- `src/` TypeScript 합계 ~101k줄, 테스트 378파일(~100k줄)
- 최대 파일: `sqlite-engine.ts` 8,528 / `operations.ts` 6,200 / `postgres-engine.ts` 4,190(→PR #176 후 ~150) / `pglite-engine.ts` 4,161(동) / `migrate.ts` 3,225 / `operations-source-registry.ts` 2,751 / `operations-memory-inbox.ts` 2,543 / `retrieve-context-service.ts` 1,513
- 오퍼레이션 ~195개, BrainEngine 129 메서드, 마이그레이션 v52
- 열린 TODOS.md 항목: PGLite WASM compiled-binary (oven-sh/bun#15032 의존) 1건

## 부록 B. 진입점 맵 (탐색 시작점)

| 알고 싶은 것 | 시작점 |
|---|---|
| 오퍼레이션 계약 전체 | `src/core/operations.ts` 하단 `operations` 배열, `operationsByName` |
| 검색 흐름 | `src/core/services/retrieve-context-service.ts:130` → `search/hybrid.ts` |
| 거버넌스 라우팅 | `src/core/services/memory-writeback-router-service.ts:59` |
| 후보 생애주기 | `src/core/memory-inbox-status.ts` + `services/memory-inbox-promotion-service.ts` |
| 세션 캡처 | `src/core/services/agent-session-memory-service.ts:71` → classifier → writeback |
| HTTP/OAuth | `src/mcp/http-server.ts`, `src/mcp/oauth.ts`, `src/commands/serve.ts` |
| 파생 잡 | `src/core/derived-jobs.ts`, `derived-worker.ts`, `import-file.ts:346` |
| 훅 자산 | `src/commands/setup-agent-hook-assets.ts` |
