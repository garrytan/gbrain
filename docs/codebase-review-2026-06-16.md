# MBrain 코드베이스 리뷰 상세 보고서 - 2026-06-16

> 2026-06-16 KST 기준 read-only 코드 리뷰 결과.
> 목적은 이미 발견된 문제를 다음 작업자가 바로 재현하고 수정할 수 있는 수준으로 정리하는 것이다.

- **기준 커밋:** `d90b1e114dfa50ca521ccf2cb779aefe85c81f9d`
- **작업 범위:** 코드 수정 없음. 문서화만 수행.
- **검토 방식:** 6개 서브에이전트 병렬 리뷰 + 본 세션의 코드 근거 재확인 + 일부 항목 직접 재현.
- **검토 축:** retrieval/read evidence boundary, writeback governance, runtime/DB, import/sync/source registry, MCP/security, CI/release.
- **검증 상태:** retrieval 관련 targeted test 124개는 서브에이전트가 통과 확인. 전체 test suite는 실행하지 않음.

---

## 0. 판단 기준

이번 리뷰는 일반적인 코드 품질보다 MBrain의 제품 목표와 불변식에 더 무게를 두었다.

MBrain은 단순 CLI나 검색 도구가 아니라, 사람과 로컬 에이전트를 위한 durable knowledge layer다. 따라서 아래 성질이 특히 중요하다.

1. `retrieve_context`는 probe이고, `read_context`가 factual answer의 evidence boundary여야 한다.
2. canonical write는 provenance, target snapshot, router decision을 거쳐야 한다.
3. raw source access는 scoped/audited여야 하며 secret을 쉽게 노출하면 안 된다.
4. Postgres target runtime과 local/offline runtime의 계약이 CI에서 함께 지켜져야 한다.
5. Markdown canonical truth와 derived/indexed data가 조용히 갈라지면 안 된다.

이 기준으로 보면 현재 코드는 강한 기초를 갖고 있지만, 몇몇 escape hatch와 검증 공백이 제품 목표를 약화시킨다.

---

## 1. 요약

### 가장 먼저 고칠 것

1. `list_source_items --include_chunks` raw text 노출 차단
2. `resolveFile` symlink escape 차단
3. `read_plan.selected_selectors`의 `content_hash` 손실 수정
4. `put_page` direct write와 router-approved canonical write 분리
5. Memory Inbox promotion/auto-promote에서 unverified candidate 차단
6. `config show`의 `postgres://` password redaction
7. backlink auto-fix가 compiled truth를 오염시키는 문제 수정
8. Postgres governance CI와 Tier 2 e2e 검증 강화

### 위험 분류

| ID | 심각도 | 영역 | 짧은 설명 |
|---|---:|---|---|
| F1 | High | Security/raw source | `list_source_items --include_chunks`가 raw source chunk를 그대로 반환 |
| F2 | High | File access | `resolveFile`이 symlink로 brain root 밖 파일을 읽을 수 있음 |
| F3 | High | Evidence boundary | `read_plan.selected_selectors`가 `content_hash`를 잃어 stale read guard가 무력화 |
| F4 | High | Write governance | `put_page`가 router/snapshot discipline을 강제하지 않음 |
| F5 | High | Candidate governance | unverified Memory Inbox candidate가 promotion될 수 있음 |
| F6 | High | Secret handling | `mbrain config show`가 `postgres://` DSN password를 노출 가능 |
| F7 | High | Markdown integrity | backlink auto-fix가 timeline evidence를 compiled truth에 삽입 가능 |
| F8 | High | CI/e2e | required CI가 Postgres governance와 real MCP/DB skill behavior를 충분히 증명하지 않음 |
| F9 | Medium-high | Data integrity | `add_timeline_entry`가 missing page에도 성공 응답 |
| F10 | Medium | Evidence boundary | frontmatter-only search hit가 evidence text 없이 answer-ready read가 될 수 있음 |
| F11 | Medium | Reliability | broad retrieval backend failure가 "no candidate"처럼 보임 |
| F12 | Medium | MCP/OAuth | OAuth body guard, raw access evaluation, compact schema required field 문제 |
| F13 | Medium | Release/runtime | source metadata skip, markdown fenced `---`, release smoke, doctor overclaim |

---

## F1. `list_source_items --include_chunks` raw source text 노출

**심각도:** High
**영역:** security, raw source access, source registry
**상태:** 코드 근거 확인. 테스트도 현재 동작을 고정함.

### 현상

`list_source_items`는 read-only inspection operation으로 보이지만, `include_chunks: true`일 때 source chunk 전체를 반환한다. 이 경로는 raw access policy, consent/pause checks, raw access ledger를 거치지 않는다.

### 증거

- `src/core/operations-source-registry.ts:404-418`
  - `include_chunks` parameter를 공개한다.
  - operation은 `mutating: false`이며 별도 raw access 평가가 없다.
- `src/core/operations-source-registry.ts:2023-2031`
  - `input.include_chunks`이면 `readSourceItemChunksForItems` 결과를 그대로 item에 붙인다.
- `src/core/source-registry/raw-ingest-store.ts:130-133`
  - SQL이 `chunk_text`, `redacted_text`를 둘 다 읽는다.
- `src/core/source-registry/raw-ingest-store.ts:437-444`
  - `mapSourceChunk`가 `chunk_text: String(row.chunk_text)`를 반환한다.
- `test/source-registry-operations.test.ts`의 include_chunks 관련 테스트가 이 동작을 기대한다.

### 왜 문제인가

MBrain rules는 raw source access가 scoped여야 하고 secret은 canonical memory가 아니어야 한다는 방향을 가진다. 그런데 이 operation은 "검사"라는 이름으로 raw text를 무감사로 반환한다. source chunk에 secret, private transcript, prompt injection payload가 들어 있으면 MCP/CLI caller가 바로 볼 수 있다.

### 권장 수정

1. 기본 반환에서는 `chunk_text`를 제거하고 `redacted_text`, `chunk_hash`, `sensitivity_flags`, `secret_risk`, `prompt_injection_risk`만 반환한다.
2. raw text가 필요하면 별도 operation을 둔다. 예: `request_raw_source_chunks`.
3. raw text operation은 반드시 `evaluate_raw_access` 또는 같은 service의 fail-closed policy를 거치고, ledger를 실제 DB에 기록한다.
4. existing tests는 raw text 반환을 기대하지 않도록 바꾸고, 별도 authorized raw access test를 추가한다.

### 검증

- `list_source_items` with `include_chunks: true`가 `chunk_text`를 포함하지 않는지 확인.
- authorized raw access operation만 ledger row를 만들고 raw text를 반환하는지 확인.
- secret-risk chunk fixture를 만들어 unauthorized path에서 raw secret이 응답에 없는지 확인.

---

## F2. `resolveFile` symlink escape

**심각도:** High
**영역:** file access, import/source resolution
**상태:** 직접 재현 완료.

### 현상

`resolveFile(filePath, brainRoot)`는 lexical path containment만 확인한다. brain root 내부에 symlink가 있고 그 symlink가 root 밖 파일을 가리키면, root 밖 파일을 `local` source로 읽는다.

### 증거

- `src/core/file-resolver.ts:39-44`
  - `resolvePath(brainRoot, filePath)`가 `resolvedRoot` 아래인지 문자열 prefix로 확인한다.
- `src/core/file-resolver.ts:46-50`
  - 실제 read는 `join(brainRoot, filePath)`에 대해 `existsSync` 후 `readFileSync`를 수행한다.
  - `realpathSync` 또는 `lstatSync`가 없다.
- `test/file-resolver.test.ts:60` 근처는 `../../etc/passwd` path traversal만 막는다. symlink escape coverage는 없다.

### 재현 스케치

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/brain/raw"
printf 'outside-secret' > "$tmp/outside-secret.txt"
ln -s "$tmp/outside-secret.txt" "$tmp/brain/raw/link.txt"
bun --eval "import { resolveFile } from './src/core/file-resolver.ts'; const r = await resolveFile('raw/link.txt', '$tmp/brain'); console.log(r.source + ':' + r.data.toString())"
```

현재 동작은 `local:outside-secret`로 재현된다.

### 왜 문제인가

file resolver는 local source ingestion과 연결된다. root containment가 보안 경계라면 symlink는 반드시 realpath 기준으로 판단해야 한다.

### 권장 수정

1. `brainRoot`와 target 모두 `realpathSync.native` 또는 async equivalent로 정규화한다.
2. target이 존재하지 않는 redirect fallback 경로도 동일한 containment rule을 적용한다.
3. symlink를 허용할지 금지할지 명시한다.
   - 안전 기본값: symlink target이 brain root 밖이면 거부.
   - 더 안전한 값: symlink 자체를 local file source에서 거부.

### 검증

- brain root 내부 symlink가 root 밖을 가리키는 fixture 추가.
- symlink가 root 내부 파일을 가리키는 경우의 의도된 동작도 함께 고정.

---

## F3. `read_plan.selected_selectors`가 `content_hash`를 잃음

**심각도:** High
**영역:** retrieval/read evidence boundary, stale read protection
**상태:** 코드 근거 확인. retrieval targeted tests 124개 통과했지만 이 케이스는 빠져 있음.

### 현상

`retrieve_context`는 canonical read selector를 만들 때 page snapshot hash를 포함할 수 있다. 하지만 documented handoff인 `read_plan.selected_selectors`는 selector object가 아니라 selector id string 배열이다. 이 id에는 `content_hash`가 들어가지 않는다.

결과적으로 caller가 문서 안내대로 `read_context`에 `read_plan.selected_selectors`를 넘기면, stale selector guard가 작동할 snapshot metadata를 잃는다.

### 증거

- `src/core/services/retrieve-context-service.ts:1426-1460`
  - `buildReadPlan`이 `input.required_reads.map(retrievalSelectorId)`로 string id 배열을 만든다.
- `src/core/operations.ts:5481`
  - tool description은 `read_plan.selected_selectors`로 `read_context`를 호출하라고 안내한다.
- `src/core/services/read-context-service.ts:1065-1088`
  - stale guard는 `selector.content_hash`가 있을 때만 mismatch를 감지한다.
- `src/core/operations.ts`의 selector id parser 경로는 id에서 kind/scope/slug/offset만 재구성하고 hash는 복원할 수 없다.

### 왜 문제인가

MBrain의 read boundary는 "probe result를 보고 바로 답하지 말고 canonical read를 하라"는 구조다. 그런데 probe와 read 사이에 page가 바뀌면, offset 기반 selector가 새 content 위에서 엉뚱한 text를 읽을 수 있다. `content_hash`가 없으면 "stale continuation" warning도 못 낸다.

### 권장 수정

선호안:

1. `read_plan.selected_selectors`를 full selector object 배열로 바꾼다.
2. 기존 string clients를 위해 `selected_selector_ids`를 별도 필드로 둔다.
3. `read_context`는 full object를 우선 받는다.

호환성 보존안:

1. 기존 `selected_selectors: string[]`는 유지한다.
2. `selected_selector_snapshots: RetrievalSelector[]` 또는 `required_reads`의 full selector를 documented handoff로 격상한다.
3. docs/tool text를 즉시 바꾼다.

### 검증

1. `retrieve_context`로 section selector를 받는다.
2. 같은 page를 mutate한다.
3. old `read_plan.selected_selectors`를 따라 `read_context`를 호출한다.
4. 기대값: stale warning 또는 stale error가 반드시 나온다.

---

## F4. `put_page`가 router/snapshot discipline을 강제하지 않음

**심각도:** High
**영역:** write governance, canonical memory safety
**상태:** 코드 근거 확인. 이 동작은 일부 테스트와 smoke가 현재 허용하고 있음.

### 현상

rules는 canonical write가 `route_memory_writeback`을 거치고, router가 준 `expected_content_hash`를 `put_page`에 전달해야 한다고 말한다. 하지만 operation 자체는 `expected_content_hash`를 optional로 둔다. 값이 없으면 locked/precondition path를 쓰지 않는다.

### 증거

- `src/core/operations.ts:2972-2988`
  - `put_page` params에서 `expected_content_hash`가 nullable optional이다.
- `src/core/operations.ts:3031-3033`
  - `expectedContentHash !== undefined`일 때만 `getPageForUpdate`; 아니면 `getPage`.
- `src/core/operations.ts:3040-3075`
  - conflict checks도 expected hash가 제공된 경우만 의미 있게 작동한다.
- `scripts/smoke-test-installed-mcp.ts:169-172`
  - installed smoke가 `put_page`를 직접 호출하며 expected hash를 전달하지 않는다.

### 왜 문제인가

MBrain의 canonical truth는 durable memory다. direct `put_page`가 admin escape hatch로 필요할 수는 있지만, agent-facing operation과 같은 표면에 있으면 governance rule이 문서 규칙에 머문다. 특히 MCP caller는 "route first"를 지키지 않고 canonical write를 할 수 있다.

### 권장 수정

1. agent-facing `put_page`와 admin/local repair용 direct write를 분리한다.
   - 예: `put_page`는 expected hash 또는 router grant required.
   - 예: `admin_put_page`는 local CLI only 또는 explicit unsafe flag.
2. router decision에서 write grant artifact를 반환한다.
   - fields: route id, target slug, expected hash, source refs, actor/session, expiry.
3. `put_page`는 grant와 expected hash가 없으면 reject한다.
4. ledger에는 caller가 expected precondition을 실제로 제공했는지 보존한다. 기존처럼 previous hash로 backfill하면 사후 감사가 흐려진다.

### 검증

- direct `put_page` without expected hash가 agent/MCP 경로에서 reject되는지.
- router-approved canonical write가 matching hash에서만 succeed하는지.
- stale hash가 conflict를 내고 canonical page를 바꾸지 않는지.
- installed smoke는 router dry-run + expected hash path로 갱신.

---

## F5. unverified Memory Inbox candidate promotion

**심각도:** High
**영역:** Memory Inbox, auto-promote, governance
**상태:** 코드 근거 확인. auto-promote는 기본 disabled지만 켰을 때 기본값이 위험하다.

### 현상

Memory Inbox promotion preflight는 `verification_status: refuted`만 deny한다. 일반 `unverified` candidate는 target/provenance만 있으면 promotion될 수 있다. auto-promote도 기본 eligibility에서 `require_verification: false`다.

### 증거

- `src/core/services/memory-inbox-service.ts:98-132`
  - preflight deny reasons에 unverified deny가 없다.
  - `refuted`만 명시적으로 deny한다.
- `src/core/services/memory-inbox-service.ts:435-442`
  - `requiresRevalidation`은 procedure/other만 unverified 상태를 defer한다.
- `src/core/auto-promote/config.ts:30-42`
  - `require_verification: false`.
- `src/core/auto-promote/candidate-selector.ts:84-88`
  - verification check는 config flag가 true일 때만 적용된다.
- `test/auto-promote/config.test.ts:21-24`
  - 현재 default를 테스트가 고정한다.

### 왜 문제인가

Memory Inbox는 "non-canonical signal"을 canonical truth로 승격하기 전의 완충지대다. unverified promotion이 가능하면 후보와 canonical의 경계가 약해진다. 특히 자동화가 켜지는 순간 LLM verdict가 verification 역할을 대체할 수 있다.

### 권장 수정

1. promotion preflight에서 기본적으로 `verification_status !== 'verified'`를 deny 또는 defer한다.
2. 예외가 필요하면 candidate type별로 명시한다.
   - direct user statement + source refs + low sensitivity는 "verified equivalent"로 볼지 정책화.
3. auto-promote default를 `require_verification: true`로 바꾼다.
4. LLM accept verdict와 verification을 분리한다.
   - LLM accept: "promote 가능성 있음"
   - verification: "source/evidence로 사실 확인됨"

### 검증

- service/operation/SQLite/Postgres 각 경로에서 unverified promotion이 막히는지.
- auto-promote enabled 상태에서 unverified candidate가 handoff_only/deferred로 남는지.
- verified candidate는 기존 happy path로 승격되는지.

---

## F6. `mbrain config show`가 `postgres://` password를 노출 가능

**심각도:** High
**영역:** secret handling, CLI UX
**상태:** 코드 근거 확인.

### 현상

config redaction은 `postgresql://`만 처리한다. 그런데 runtime DSN parser와 init 안내는 `postgres://`도 허용한다.

### 증거

- `src/commands/config.ts:4-9`
  - regex가 `postgresql://`만 redacts.
- `src/commands/config.ts:47-48`
  - 값에 `postgresql://`가 포함될 때만 redaction function을 호출한다.
- `src/core/postgres-runtime/connection-profile.ts:96-103`
  - parser는 `postgres:`와 `postgresql:` protocol을 둘 다 허용한다.
- `src/commands/init.ts:175`, `src/commands/init.ts:382`
  - user-facing help도 `postgres://`를 허용한다.

### 왜 문제인가

`mbrain config show`는 사용자가 진단/공유/로그에 붙이기 쉬운 명령이다. DSN password는 노출되면 치명적이고, `postgres://`는 널리 쓰이는 alias다.

### 권장 수정

1. regex 대신 URL parser 기반 redaction을 사용한다.
2. protocols: `postgres:`, `postgresql:` 모두 처리한다.
3. username/password뿐 아니라 query param에 secret-like key가 있으면 redact한다.
4. `config get database_url` 같은 단일 key 조회도 redaction할지 정책을 명확히 한다.

### 검증

- `postgres://user:pass@host/db` -> `postgres://user:***@host/db`.
- `postgresql://user:pass@host/db` 기존 동작 유지.
- URL parse 실패 시 secret-like fallback redaction 적용.

---

## F7. backlink auto-fix가 timeline evidence를 compiled truth에 넣을 수 있음

**심각도:** High
**영역:** Markdown canonical integrity, backlinks
**상태:** 직접 재현 완료.

### 현상

`fixBacklinkGaps`는 target page에 literal `## Timeline`이 없으면 `## Timeline` section을 append한다. 하지만 MBrain parser의 canonical boundary는 `## Timeline`이 아니라 standalone `---` separator다. 따라서 separator 없는 page에서는 새 backlink evidence가 compiled truth에 들어간다.

### 증거

- `src/commands/backlinks.ts:270-284`
  - `## Timeline` 문자열을 기준으로 삽입하고, 없으면 `## Timeline`을 append한다.
- `src/core/markdown.ts:68-92`
  - parser는 standalone `---`만 compiled truth/timeline boundary로 본다.
- `src/commands/backlinks.ts:184-187`
  - backlink entry 자체도 documented context 형태보다 짧다.

### 재현 결과

separator 없는 page에 대해 `fixBacklinkGaps`를 실행하면:

- fixed count는 1 증가.
- 다음 parse에서 `timeline`은 빈 문자열.
- backlink entry는 `compiled_truth`에 포함.

### 왜 문제인가

MBrain에서 compiled truth는 현재 사실 요약이고, timeline은 evidence log다. auto-fix가 evidence를 compiled truth에 넣으면 canonical page의 의미 구조를 손상한다.

### 권장 수정

1. `fixBacklinkGaps`를 string split 기반이 아니라 `parseMarkdown`/`serializeMarkdown` 기반으로 바꾼다.
2. separator가 없는 page는 자동 수정 전에 canonical separator를 삽입하거나, lint error로 보고하고 수정하지 않는다.
3. backlink entry는 rules의 context 요구에 맞춰 `-- context`를 포함하도록 확장한다.

### 검증

- separator 있는 page: timeline에 backlink가 들어간다.
- separator 없는 page: either canonical separator 삽입 후 timeline에 들어가거나, fix가 fail/skip된다.
- compiled truth에는 backlink evidence가 추가되지 않는다.

---

## F8. required CI/e2e가 target runtime governance를 충분히 증명하지 않음

**심각도:** High
**영역:** CI, Postgres target runtime, skills e2e
**상태:** workflow/test 근거 확인.

### 현상 A: Postgres governance tests가 required aggregator에 묶여 있지 않음

`.github/workflows/test.yml`의 `test` aggregator는 `typecheck`, `test-shard`, `test-macos`만 필요로 한다. 별도 `postgres-jsonb` job은 `test/postgres-jsonb-engine.test.ts`만 실행한다.

### 증거 A

- `.github/workflows/test.yml:82-101`
  - aggregator needs: `[typecheck, test-shard, test-macos]`.
- `.github/workflows/test.yml:103-127`
  - `postgres-jsonb` job은 JSONB test 하나만 실행한다.
- 여러 Postgres-specific governance tests는 `DATABASE_URL` 없으면 skip된다.
  - 예: memory inbox schema, mutation ledger, canonical handoff 계열.

### 현상 B: Tier 2 skills e2e가 real MCP/DB 효과를 증명하지 않음

Tier 2 OpenClaw config는 `${{ env.DATABASE_URL }}`를 사용하지만, `DATABASE_URL`은 later test step의 step-local env로만 설정된다. config 작성 시점에는 job-level env가 없다.

또한 skills test 자체도 DB 상태를 assert하지 않고 non-empty output + exit code 0 중심이다.

### 증거 B

- `.github/workflows/e2e.yml:76-87`
  - OpenClaw config에 `${{ env.DATABASE_URL }}`를 쓴다.
- `.github/workflows/e2e.yml:92-97`
  - `DATABASE_URL`은 test step env에만 있다.
- `test/e2e/skills.test.ts:117-145`
  - 주석이 "agent uses its own configured DB, not the test DB"라고 말하고, DB state를 assert하지 않는다.

### 왜 문제인가

MBrain의 목표 runtime은 Postgres + pgvector다. governance, ledger, handoff, source registry가 SQLite/PGLite에서만 안정적이어도 실제 target runtime drift는 놓칠 수 있다. Tier 2도 agent가 그럴듯한 답변만 하면 통과할 수 있어, MCP wiring이나 DB targeting failure를 놓친다.

### 권장 수정

1. `postgres-target-runtime` required job 추가.
   - memory inbox schema
   - mutation ledger
   - canonical handoff
   - source registry raw access/ledger
   - route writeback/put_page precondition
2. aggregator `test`가 `postgres-target-runtime`을 needs에 포함하게 한다.
3. Tier 2는 job-level `DATABASE_URL`을 설정하거나 config step에 literal DSN을 쓴다.
4. skills e2e는 최소 DB effects를 assert한다.
   - pages created/updated
   - candidates created/rejected/promoted
   - retrieval trace recorded
   - timeline entries present

### 검증

- PR에서 Postgres governance regression을 넣으면 required CI가 fail해야 한다.
- Tier 2에서 MCP server가 wrong DB를 바라보면 fail해야 한다.

---

## F9. `add_timeline_entry`가 missing page에도 성공 응답

**심각도:** Medium-high
**영역:** data integrity, operations contract
**상태:** 직접 재현 완료.

### 현상

존재하지 않는 slug에 `add_timeline_entry`를 호출해도 operation은 `{ status: 'ok' }`를 반환할 수 있다. 실제 timeline row는 생성되지 않는다.

### 증거

- `src/core/operations.ts:3473-3492`
  - handler는 `ctx.engine.addTimelineEntry(...)` 후 항상 `{ status: 'ok' }`.
- SQLite engine은 missing page id면 return만 한다.
- Postgres path도 `INSERT ... SELECT id FROM pages WHERE slug = $1` 형태면 0 rows insert가 가능하다.

### 재현 결과

missing slug에 대해 operation 호출 결과:

```json
{"result":{"status":"ok"},"timelineLength":0}
```

### 왜 문제인가

timeline은 evidence log다. "성공했지만 아무 것도 기록되지 않음"은 agent workflow에서 치명적이다. 특히 ingestion/enrichment skill은 timeline write 성공을 믿고 다음 단계로 넘어갈 수 있다.

### 권장 수정

1. engine `addTimelineEntry` contract를 "missing page면 throw 또는 false return"으로 바꾼다.
2. operation은 affected row count를 확인해 missing page를 `not_found` error로 반환한다.
3. SQLite/Postgres/PGLite parity test를 추가한다.

### 검증

- missing page는 fail.
- existing page는 timeline length 증가.
- CLI/MCP response가 failure를 명확히 전달.

---

## F10. frontmatter-only search evidence가 read에서 사라질 수 있음

**심각도:** Medium
**영역:** evidence boundary, frontmatter indexing
**상태:** 코드 근거 확인.

### 현상

frontmatter fields는 searchable chunk로 indexing된다. 하지만 해당 hit가 read selector로 바뀔 때 non-timeline/non-compiled chunk가 `page` selector로 매핑되고, default page read는 compiled truth만 반환한다. 즉 검색에서 매칭된 frontmatter value가 canonical read에는 나오지 않을 수 있다.

### 증거

- `src/core/import-file.ts:619-630`
  - frontmatter 기반 searchable text/chunk 생성.
- `src/core/markdown.ts:164-202`
  - frontmatter search text build.
- `src/core/services/retrieval-selector-service.ts:85-95`
  - non timeline/compiled chunk를 page selector로 매핑.
- `src/core/services/read-context-service.ts:188-193`
  - default page read는 compiled truth만 읽는다.

### 왜 문제인가

`retrieve_context`가 찾은 사실과 `read_context`가 반환하는 evidence가 다르면, agent는 "evidence boundary를 통과했다"고 생각하지만 실제 증거 text는 없다. codemap, repo, build command 같은 frontmatter-only metadata에서 특히 위험하다.

### 권장 수정

1. frontmatter selector kind를 별도로 둔다.
2. `read_context`가 frontmatter field/value를 canonical evidence로 반환한다.
3. 또는 frontmatter-only hit는 answer-ready가 아니라 orientation으로 낮춘다.

### 검증

- frontmatter에만 존재하는 needle로 retrieve -> read.
- read 결과에 needle과 field name이 있어야 한다.
- 없으면 read_plan이 answer-ready로 표시되지 않아야 한다.

---

## F11. broad retrieval backend failure가 "no candidate"처럼 보임

**심각도:** Medium
**영역:** reliability, observability
**상태:** 코드 근거 확인.

### 현상

`searchCandidatePool`은 query variants를 `Promise.allSettled`로 실행하고 rejected result를 drop한다. 모든 variant가 실패해도 결과는 빈 배열이 되고, caller는 "no canonical read candidate" 쪽 reason을 낼 수 있다.

### 증거

- `src/core/services/retrieve-context-service.ts:551-560`
  - `Promise.allSettled`.
- 같은 함수의 후속 flatMap 경로에서 rejected failure가 surfaced warning/error로 남지 않는다.
- `broadRetrievalReasonCodes`는 required reads가 없고 candidate signals도 없으면 `no_candidate`.

### 왜 문제인가

durable memory layer에서 "검색 실패"와 "기억 없음"은 전혀 다르다. 실패를 absence로 바꾸면 agent가 잘못된 결론을 낼 수 있다.

### 권장 수정

1. original query failure는 반드시 warning/error로 surface한다.
2. all variants failure면 `retrieval_backend_failed` gap reason을 반환한다.
3. optional expansion failure만 tolerant하게 무시한다.
4. retrieval trace에 failed backend/variant count를 기록한다.

### 검증

- candidateSearch가 throw하는 fake를 주입.
- 기대값: `no_candidate`가 아니라 backend failure warning.

---

## F12. MCP/OAuth trust-boundary 정리 필요

**심각도:** Medium
**영역:** MCP, OAuth, tool schema
**상태:** 코드 근거 확인.

### F12-a. OAuth endpoints가 `/mcp` body size guard를 우회

- `src/mcp/http-server.ts:91` 근처에서 OAuth route가 `/mcp` body bounding보다 먼저 dispatch된다.
- OAuth body reader는 `request.json()`/`request.text()`를 직접 사용한다.
- oversized body test는 `/mcp`에만 있다.

**권장 수정:** OAuth body reader에도 동일한 max bytes guard를 적용한다.

### F12-b. `evaluate_raw_access`가 caller-supplied policy를 authority처럼 받음

- `src/core/operations-source-registry.ts:488-506`
  - operation description은 "Evaluate and audit"인데, `policy`가 required input이다.
- service는 ledger entry object를 반환하지만 operation이 DB에 persist하지 않는다.

**권장 수정:** operation은 source policy를 DB에서 resolve하고, allow/deny ledger를 기록해야 한다. caller-supplied policy는 test helper 또는 dry-run 전용으로 낮춘다.

### F12-c. compact MCP schema에서 `required`가 빠짐

- `src/mcp/tool-schema.ts`가 compact mode에서 required metadata를 생략한다.
- stdio server는 compact schema가 기본이다.

**권장 수정:** compact mode에서도 `required`는 유지한다. 토큰 비용은 작고 tool usability 영향은 크다.

---

## F13. 기타 medium-risk 개선 항목

### F13-a. source registry connector ingest가 metadata-only update를 skip

**증거:** `src/core/operations-source-registry.ts:1356-1361`에서 metadata/timestamps를 plan에 넣지만, `1367-1372`에서 existing content hash가 같으면 skip한다. content hash는 raw body 중심이다.

**영향:** connector item title, locator, `source_updated_at`, metadata가 바뀌어도 body가 같으면 stale metadata가 남는다.

**권장 수정:** content hash와 metadata hash를 분리하거나, metadata-only update path를 둔다.

### F13-b. markdown parser가 fenced code 안의 standalone `---`를 separator로 오인 가능

**증거:** `src/core/markdown.ts:68-92`는 fence context 없이 line trim만 본다.

**영향:** compiled truth에 예시 YAML/markdown fence가 있으면 timeline으로 잘릴 수 있다.

**권장 수정:** fence-aware parser를 쓰거나, fenced standalone `---`를 import lint error로 만든다.

### F13-c. release binary smoke가 `--version`에 그침

**증거:** `.github/workflows/release.yml:41-48`은 compiled binary를 만들고 `--version`만 실행한다. release smoke는 source-level `bun run` smoke다.

**영향:** packaging-only break, bundled import break, compiled MCP stdio break가 release 전에 빠질 수 있다.

**권장 수정:** `MBRAIN_SMOKE_COMMAND=bin/${{ matrix.artifact }} bun run smoke:installed-mcp`를 artifact upload 전에 실행한다.

### F13-d. doctor/RLS/embedding health 메시지가 과장될 수 있음

**증거:** doctor RLS check는 제한된 core table list를 확인하면서 "all tables"류 메시지를 낼 수 있다. local embedding provider는 config상 available이면 provider OK로 보일 수 있다.

**영향:** operator가 실제 raw/source/credential table coverage나 MLX runtime health를 오판할 수 있다.

**권장 수정:** 메시지를 "core tables"로 좁히거나 실제 all table introspection으로 확장한다. embedding은 provider config와 live probe를 분리해 표시한다.

---

## 2. 실행 순서 제안

### Phase A. 보안/데이터 오염 차단

1. F1 raw chunk exposure 차단.
2. F2 symlink escape 차단.
3. F6 config DSN redaction 수정.
4. F7 backlink auto-fix compiled truth 오염 수정.

이 네 가지는 blast radius가 비교적 작고, 회귀 테스트가 명확하다.

### Phase B. MBrain 핵심 계약 강화

1. F3 selector hash handoff 복구.
2. F4 router-approved canonical write path 강제.
3. F5 unverified promotion 차단.
4. F9 missing page timeline write failure 처리.

이 단계는 product invariant와 직결된다. 기존 tests/smokes가 direct path를 허용하므로 migration/compatibility note가 필요하다.

### Phase C. CI/release가 목표 runtime을 지키게 만들기

1. F8 `postgres-target-runtime` required job 추가.
2. Tier 2 `DATABASE_URL` config와 DB effects assertions 수정.
3. F13-c compiled artifact MCP smoke 추가.
4. release tag/version lockstep test 추가.

### Phase D. 관측성과 정직성 개선

1. F10 frontmatter evidence read path 정리.
2. F11 retrieval backend failure warning.
3. F12 OAuth/raw access/schema cleanup.
4. F13-a/b/d medium-risk cleanup.

---

## 3. 권장 테스트 목록

### Security/raw source

- unauthorized `list_source_items(include_chunks=true)` does not return `chunk_text`.
- authorized raw access creates ledger row and returns only requested chunks.
- source with `secret_risk` never leaks raw text through inspection endpoints.

### File resolver

- symlink inside brain root to outside file is rejected.
- symlink inside brain root to inside file follows documented policy.
- `.redirect` marker path is checked with the same containment rule.

### Retrieval/read boundary

- retrieve section selector, mutate page, read old selector -> stale warning/error.
- frontmatter-only hit appears in `read_context` evidence or is not answer-ready.
- search backend throws -> retrieval result has backend failure warning.

### Write governance

- direct agent/MCP `put_page` without expected hash or grant rejects.
- router-approved write with matching hash succeeds.
- stale hash rejects and writes no page.
- ledger records whether caller supplied the precondition.

### Memory Inbox

- unverified candidate promotion denied/deferred.
- verified candidate promotion succeeds.
- auto-promote enabled with unverified candidate does not canonicalize it.
- SQLite/PGlite/Postgres behavior matches.

### Markdown/canonical integrity

- backlink fix on separator page appends to timeline only.
- backlink fix on no-separator page does not put evidence into compiled truth.
- fenced code block containing standalone `---` is preserved or explicitly rejected.

### CI/release

- required CI fails on Postgres governance regression.
- Tier 2 fails when MCP server points to wrong DB.
- compiled artifact passes installed MCP smoke, not just `--version`.

---

## 4. Notes for future implementers

- Do not fix all findings in one PR. F1/F2/F6/F7 can be a tight security/data-integrity PR.
- F3/F4/F5 should probably be separate PRs because they alter public/tool contracts.
- F4 may need a compatibility path for local admin writes. Keep that path explicit and scary rather than silently available to agent clients.
- F8 is best done soon after F4/F5, so the new invariants are required in CI.
- Existing docs already teach the correct agent discipline. The main gap is enforcement in operation contracts and tests.
