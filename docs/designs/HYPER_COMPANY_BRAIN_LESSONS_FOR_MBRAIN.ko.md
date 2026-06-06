# Hyper HN Launch에서 얻은 MBrain 개선 아이디어

Date: 2026-06-04
Status: Strategy memo
Branch: `hyper-memory-ideas-doc`

## 목적

Hacker News의 [Launch HN: Hyper (YC P26) - Company brain to power agentic development](https://news.ycombinator.com/item?id=48387095)
스레드를 읽고, 그 안의 제품/아키텍처 주장과 비판을 `mbrain`의 현재 설계와 대조했다.

이 문서의 목적은 Hyper를 복제하는 것이 아니다. 목적은 이미 `mbrain`에 있는 강한 기반을 확인하고,
그 위에서 더 큰 도약을 만들 수 있는 아이디어를 고르는 것이다.

분석에는 네 개의 독립 subagent 관점을 합쳤다.

- Architecture: raw episode, assertion graph, typed edge, async extraction 관점
- Product/UX: hook transparency, trust, onboarding, 5-minute value 관점
- Retrieval/Eval: graph-aware retrieval, canonical grounding, memory benchmark 관점
- Skeptical review: 과장된 아이디어, hidden constraint, 더 차별화된 아이디어 관점

## 한 줄 결론

Hyper 스레드는 `mbrain`의 방향이 맞다는 강한 검증이다. 하지만 `mbrain`의 다음 도약은
"RAG를 더 잘한다"가 아니라 **agentic work를 위한 trust-maintenance runtime**이 되는 것이다.

핵심은 세 가지다.

1. `assertions`를 새로 만들자는 것이 아니라, 이미 있는 assertion/governance substrate를
   retrieval, review, eval, UX의 중심으로 승격한다.
2. graph와 derived map은 truth가 아니라 orientation이다. graph는 canonical evidence를 더 잘 찾게
   해야지, 독립적으로 답하게 만들면 안 된다.
3. hosted company brain이 편의성을 판다면, `mbrain`은 local/open/inspectable memory와
   verifiable governance를 팔아야 한다.

## Hyper 스레드에서 관찰한 외부 신호

Hyper가 설명한 시스템은 전통적인 chunk RAG가 아니다. 스레드에서 설명된 핵심 구조는 다음과 같다.

- raw episode를 source of truth로 보관한다.
- episode에서 fact를 추출하고, fact는 subject-predicate-object 형식과 plain summary를 가진다.
- fact에는 introduced/invalidated timestamp가 있고, supersession을 통해 stale information을 다룬다.
- fact graph에는 `derived_from`, `supersedes`, `in_tension_with` 같은 관계가 있다.
- 모든 fact에는 provenance와 access-control tag가 붙는다.
- retrieval은 query expansion, embedding search, Postgres full-text search, reciprocal rank fusion을 섞는다.
- agent lifecycle hook을 통해 session 시작, prompt, agent turn 종료 같은 지점에서 context를 넣고 signal을 뽑는다.
- graph update는 하나의 mega-agent가 아니라 좁은 agent들의 production line으로 운영한다.
- memory의 가치는 compounding되지만, 제품은 5분 안에 가치가 보이도록 만들어야 한다.

HN 댓글에서 나온 중요한 비판도 있다.

- hook 설치가 투명하지 않으면 memory product는 신뢰를 잃는다.
- 회사 지능이 hosted vendor에 잠기는 것에 대한 두려움이 크다.
- knowledge graph로 바꾸는 과정에서 intent와 context가 손실될 수 있다.
- recency만으로 conflict를 해결하면 오래됐지만 권위 있는 source를 잘못 밀어낼 수 있다.
- "graph를 쓴다"는 것만으로는 차별화가 어렵다. UX, governance, 운영 안정성이 승부처다.
- 이 문제는 vibe coding으로 80%처럼 보여도 long tail, access control, quality issue가 빠르게 폭발한다.

## MBrain이 이미 가진 강점

Hyper의 핵심 아이디어 중 많은 부분은 `mbrain`에 이미 존재한다. 그래서 전략 문서는 "새로 만들자"보다
"이미 있는 것을 product-grade loop로 연결하자"에 집중해야 한다.

### Canonical Markdown + compiled truth/timeline

`mbrain`은 human-editable Markdown을 canonical artifact로 둔다.
`docs/guides/compiled-truth.md`는 compiled truth와 append-only timeline을 분리한다.
이는 Hyper의 raw episode/fact 분리와 목적은 비슷하지만, 사람의 검토/수정 가능성을 더 강하게 보존한다.

### Source, provenance, raw evidence

`docs/superpowers/specs/2026-05-20-mbrain-phase-02-raw-ingest-provenance.md`와
`src/schema.sql`의 source 관련 테이블은 source item, source chunk, hash, prompt-injection flag,
secret flag, raw access ledger 방향을 이미 잡고 있다.

### Assertion pipeline

`docs/superpowers/specs/2026-05-20-mbrain-phase-03-assertion-pipeline.md`와 `src/schema.sql`에는
`extracted_claims`, `assertions`, `assertion_evidence`, `assertion_lineage`, `assertion_links`,
`conflict_sets`가 있다.

따라서 "fact graph를 만들자"는 제안은 부분적으로 이미 해결된 문제다. 남은 문제는 assertion을
더 잘 materialize하고 retrieval/writeback/UX에서 일관되게 쓰는 것이다.

### Governed canonical write

`docs/superpowers/specs/2026-05-20-mbrain-phase-04-governed-canonical-write.md`는 source kind,
claim type, confidence, sensitivity, prompt injection, conflict, validity window, session grant,
runner trust level을 policy input으로 삼는다.

이는 Hyper의 "trust humans, trust recent human info more"보다 더 강한 방향이다.

### Memory Inbox

`README.md`와 `docs/architecture/redesign/06-workstream-governance-and-inbox.md`는 Memory Inbox를
candidate, review, promotion, rejection, supersession의 canonical governance boundary로 둔다.
이것은 agent가 useful signal을 발견하되 truth를 오염시키지 않게 하는 핵심 장치다.

### Hybrid retrieval + evidence boundary

`src/core/search/hybrid.ts`는 keyword/vector search와 RRF를 구현한다.
`docs/guides/search-modes.md`는 `retrieve_context -> read_context`를 factual answer의 evidence boundary로 둔다.
이 점은 단순 RAG보다 더 엄격하다.

### Agent session memory 설계

`docs/superpowers/specs/2026-06-03-mbrain-agent-session-memory-runtime-design.md`는 agent session을
source-backed input으로 모델링하고, redaction before compression, session-end summary,
classifier, writeback routing, authority-aware activation을 제안한다.

## 핵심 갭

### 1. Assertion substrate는 있지만 retrieval/product의 중심이 아니다

스키마와 spec은 강하지만, 사용자가 체감하는 surface는 아직 "assertion truth-maintenance runtime"보다
"Markdown memory + search + governance"에 가깝다.

다음 도약은 assertion graph를 별도 저장소로 새로 만드는 것이 아니라, 현재 assertion/evidence/link를
다음 네 곳에 직접 연결하는 것이다.

- retrieval ranking
- canonical read selection
- Memory Inbox review
- eval/replay metrics

### 2. Graph semantics가 너무 자유롭다

`assertion_links.link_type`은 generic surface다. Hyper식 typed edge를 무작정 늘리기보다, `mbrain`에 맞는
작고 엄격한 ontology가 필요하다.

추천 edge type:

- `supports`
- `contradicts`
- `supersedes`
- `superseded_by`
- `derived_from`
- `depends_on`
- `blocks`
- `rationale_for`
- `rejected_alternative_to`
- `tension_with`
- `requires_reverification`

### 3. Graph-aware retrieval은 아직 orientation 수준이다

context map, atlas, graph command는 있지만, `retrieve_context`의 primary ranking과 selector planning에
graph-derived signal이 깊게 통합된 상태는 아니다.

중요한 원칙:

> graph는 답의 근거가 아니라, 답의 근거를 찾는 방법이다.

따라서 graph traversal은 bounded, traceable, canonical-read-seeking이어야 한다.

### 4. Real-time extraction은 inbox debt를 만든다

Hyper는 real-time async extraction을 강조한다. 하지만 `mbrain`에서는 이것을 바로 모든 connector에 확대하면
candidate spam과 review debt가 커질 수 있다.

먼저 필요한 것은 ingestion volume이 아니라 triage quality다.

### 5. Identity drift가 graph density보다 중요하다

사람, 회사, 프로젝트, repo, branch, alias는 시간이 지나며 합쳐지고 갈라진다.
fact graph가 조밀해질수록 identity merge/split 오류가 더 큰 문제를 만든다.

`mbrain`은 graph expansion 전에 identity lineage를 별도 priority로 잡아야 한다.

### 6. Hook trust UX가 제품 신뢰의 첫 관문이다

HN에서 나온 반발은 "hook이 왜 필요한가"가 아니라 "무엇이 설치되는지 명확했는가"에 가까웠다.
`mbrain setup-agent`는 이미 강력하다. 하지만 신뢰 UX는 더 앞에 와야 한다.

## 추천 로드맵

### P0. Trust policy engine + freshness contracts

가장 먼저 강화해야 할 것은 더 많은 memory가 아니라 더 믿을 수 있는 memory다.

제안:

- claim type별 authority rule을 명시한다.
- source kind, role, scope, freshness window, verification mode를 조합해 confidence를 계산한다.
- recency는 기본 signal 중 하나일 뿐, 최종 authority rule이 되면 안 된다.
- 모든 durable artifact가 "언제 stale해지는지"와 "어떻게 revalidate하는지"를 선언한다.

예시:

```text
code_claim:
  valid_until: commit hash or branch head changes
  revalidate: live workspace grep/test/build

vendor_decision:
  valid_until: superseded decision or review_after date
  revalidate: decision packet + owner confirmation

profile_preference:
  valid_until: explicit user update or contradiction
  revalidate: direct user statement preferred
```

왜 중요한가:

- graph, hooks, real-time extraction은 모두 trust policy 품질을 증폭한다.
- policy가 약하면 더 많은 memory는 더 많은 오답이 된다.

### P1. First-class decision packets

일반적인 SPO triple보다 agentic development에 더 유용한 단위는 decision packet이다.

Decision packet은 다음을 묶는다.

- claim: 무엇을 결정했는가
- rationale: 왜 그렇게 결정했는가
- rejected alternatives: 무엇을 버렸는가
- owner: 누가/어떤 source가 책임지는가
- validity window: 언제까지 유효한가
- revalidation path: 무엇이 바뀌면 다시 확인해야 하는가
- source refs: 어떤 evidence에서 왔는가

이것은 `assertions` 위에 materialized view나 projection으로 만들 수 있다.
새 truth store로 만들면 안 된다.

### P2. Negative memory

agentic development에서 "무엇을 아는가"만큼 중요한 것은 "무엇을 다시 하지 말아야 하는가"다.

제안:

- failed attempts
- dead ends
- reverted approaches
- unsafe shortcuts
- stale procedures
- "do not use this API path"
- "this benchmark looked good but was invalid"

이들을 explicit memory로 둔다.

Negative memory는 task continuity와 code work에서 특히 크다. 반복 탐색과 반복 실패를 줄이는 효과가
일반 recall보다 더 빨리 체감된다.

### P3. Event-native episode ledger + async extraction outbox

Hyper의 raw episode 아이디어를 가져오되, `mbrain`의 Markdown canonical model을 버리면 안 된다.

추천 구조:

```text
agent/session/tool/file event
  -> append-only episode ledger
  -> redaction/scope/sensitivity classification
  -> async extraction outbox
  -> extracted claim / decision / negative memory candidate
  -> assertion resolution
  -> Memory Inbox or governed canonical write
```

원칙:

- episode ledger는 source evidence다.
- compiled truth와 curated Markdown은 계속 human-editable canonical artifact다.
- extraction result는 바로 truth가 아니라 candidate/assertion input이다.

### P4. Materialized fact view over assertions

Hyper의 subject-predicate-object fact record는 retrieval에 좋다. 하지만 `mbrain`에 별도 writable fact store를
만들면 duplicate truth가 생긴다.

대안:

- `assertions + assertion_evidence + assertion_links`에서 derived/materialized fact view를 만든다.
- view는 subject, predicate, object, summary, introduced_at, invalidated_at, provenance, scope label을 제공한다.
- view는 retrieval-friendly surface일 뿐, canonical write는 assertion/governance path만 통과한다.

### P5. Strict edge ontology

graph expansion을 신뢰하려면 edge semantics가 제한되어야 한다.

제안:

- `assertion_links.link_type`에 allowlist를 둔다.
- edge type마다 direction, authority implication, retrieval use를 정의한다.
- `derived_from`은 authority를 높이지 않는다.
- `supersedes`는 historical chain을 보존한다.
- `contradicts`는 collapse가 아니라 contradiction workspace로 보낸다.
- `requires_reverification`은 default retrieval에서 answer-grounding을 막고 verify-first로 보낸다.

### P6. Bounded frontier retrieval

Graph-aware retrieval은 다음 방식으로 제한한다.

```text
query
  -> canonical candidate seed
  -> assertion/entity/source frontier
  -> 1-2 hop typed expansion
  -> rank graph candidates as orientation
  -> choose required canonical reads
  -> answer only from canonical reads
  -> persist retrieval trace with graph path
```

Eval은 graph가 답을 직접 만들었는지가 아니라, graph가 더 좋은 canonical read를 찾게 했는지를 측정해야 한다.

### P7. Identity lineage

entity identity가 변하면 fact graph는 쉽게 오염된다.

필요한 기능:

- alias history
- merge/split records
- reversible entity resolution
- source-specific identity mapping
- "these looked same but are now distinct" 기록
- historical query에서 당시 identity 기준으로 답하는 기능

이것은 people/company/project/repo memory 모두에 필요하다.

### P8. Contradiction workspace + review batching

Conflict를 즉시 하나의 best guess로 접으면 traceability가 줄어든다.

제안:

- competing assertions를 하나의 workspace로 묶는다.
- reviewer에게 source, authority, freshness, affected projections를 보여준다.
- "reject", "supersede", "keep both with scope", "requires verification"을 선택하게 한다.
- review batching으로 real-time extraction이 만든 inbox debt를 줄인다.

### P9. Transparent hook manager

`mbrain setup-agent`는 신뢰 UX를 가져야 한다.

필요한 UX:

- install preview: 어떤 파일, 어떤 hook, 어떤 MCP 등록이 바뀌는지 보여준다.
- diff mode: 실제 적용 전 diff를 출력한다.
- scope mode: Codex만, Claude만, project-local만 선택 가능하게 한다.
- uninstall/rollback: 설치한 hook과 rules를 안전하게 제거한다.
- capture preview: hook이 capture할 event 예시를 보여준다.
- `doctor --agent --explain`: 현재 agent integration 상태와 위험을 설명한다.

이것은 단순 polish가 아니다. memory product의 trust boundary다.

### P10. 5-minute proof mode

memory는 compounding product라서 가치가 늦게 보인다. 그래서 demo는 ingestion 양이 아니라 "이전보다 agent가
덜 헤맨다"를 보여줘야 한다.

추천 proof prompts:

- "지난 task에서 어디까지 했고 다음에 무엇을 해야 하지?"
- "이 결정을 왜 했고 어떤 대안을 버렸지?"
- "이 repo에서 전에 실패한 접근은 무엇이지?"
- "이 claim은 지금 branch에서 여전히 맞아?"
- "이 memory는 canonical truth야, candidate야, derived orientation이야?"

한 명령으로 sample brain + sample task trace를 import하고 위 질문을 비교할 수 있게 한다.

## 색다르거나 더 좋은 아이디어

### Memory lint / operator cockpit

`mbrain`은 "기억하는 시스템"을 넘어 "기억의 품질을 검사하는 시스템"이 되어야 한다.

Operator cockpit은 다음을 보여준다.

- 왜 이 memory가 retrieval에 들어왔는가
- 어떤 candidate가 suppressed 되었는가
- 어떤 source가 stale하거나 revoked 되었는가
- 어떤 connector가 noisy한가
- 어떤 scope boundary가 개입했는가
- 어떤 assertion이 conflict 상태인가
- 어떤 projection이 drift 상태인가

이것은 hosted brain과의 차별점이다. hosted system은 magic을 판다. `mbrain`은 inspectability를 판다.

### Decision/negative-memory-first agent session capture

모든 session event를 똑같이 캡처하지 않는다.

초기 capture target은 다음에 집중한다.

- user-confirmed decisions
- failed attempts
- reverted approaches
- stable constraints
- next resume state
- code claims requiring verification

이렇게 하면 candidate spam을 줄이고, agentic development에서 빠르게 체감되는 가치를 만든다.

### Freshness as a first-class interface

모든 retrieved memory에 freshness state를 보여준다.

예시:

```text
canonical_active
canonical_stale_verify_first
candidate_only
derived_orientation
historical_only
superseded
conflicted
```

이 label은 agent가 답변을 구성할 때뿐 아니라 사람이 review할 때도 보여야 한다.

### Source-control-grade memory audit

`mbrain`의 강점은 Markdown, Postgres, provenance, mutation ledger가 함께 있다는 점이다.

추가 아이디어:

- `mbrain memory-blame <claim>`: 어떤 source와 어떤 promotion이 이 claim을 만들었는가
- `mbrain memory-log <entity>`: claim 변화 history
- `mbrain memory-diff --as-of <date>`: 특정 시점 이후 무엇이 바뀌었는가
- `mbrain memory-why <answer>`: answer에 들어간 canonical read, graph orientation, suppressed candidate

## 평가와 벤치마크

Hyper 스레드에서 LoCoMo, LongMemEval이 언급되었지만, `mbrain`은 public memory benchmark만으로 가치를
증명하면 안 된다. 더 중요한 것은 memory system 고유의 failure mode를 잡는 것이다.

추천 eval set:

| Eval | 목적 |
|---|---|
| Temporal recall set | 최신 fact가 아니라 질문 시점에 맞는 fact를 찾는지 측정 |
| Derived-vs-canonical set | map/candidate가 도움을 주되 answer grounding에는 쓰이지 않는지 측정 |
| Bridge retrieval set | 한 chunk가 아니라 여러 entity/project/source를 잇는 질문을 해결하는지 측정 |
| Stateless search ablation | `search/query`만 쓸 때와 `retrieve_context -> read_context -> assertion lifecycle`의 차이 측정 |
| Scope isolation set | work/personal/mixed scope leak 여부 측정 |
| Forgetting regression set | stale/expired/purged assertion이 기본 답변에 새지 않는지 측정 |
| Candidate-governance set | unreviewed candidate가 truth처럼 답변에 섞이지 않는지 측정 |
| Code freshness set | branch/hash가 바뀐 code claim이 verify-first로 가는지 측정 |
| Negative memory set | 과거 실패 접근을 반복하지 않는지 측정 |
| Review-debt set | real-time extraction 후 candidate backlog가 관리 가능한지 측정 |

추천 metric:

- temporal answer accuracy
- canonical grounding rate
- stale/expired retrieval leakage
- scope leak rate
- candidate pollution rate
- supersession correctness
- contradiction preservation rate
- wrong-write avoidance
- repeated-work reduction
- verification-before-answer rate for code claims
- retrieval trace completeness
- review debt per captured session
- time to candidate disposition

## 채택하지 않거나 뒤로 미룰 아이디어

### Raw episode를 유일한 truth로 삼기

`mbrain`의 차별점은 Markdown compiled truth와 timeline을 사람이 직접 읽고 고칠 수 있다는 점이다.
raw episode 중심으로 완전히 뒤집으면 이 장점을 잃는다.

### Graph를 authority로 쓰기

Graph는 search space를 좁히고 path를 설명해야 한다. graph-derived fact가 canonical read 없이 답의 근거가
되면 `mbrain`의 핵심 invariants와 충돌한다.

### 모든 것을 real-time extraction으로 보내기

초기에는 좋아 보이지만 candidate spam, cost, review debt, privacy risk가 커진다.
먼저 decision/negative-memory/task-continuation 중심으로 좁게 시작해야 한다.

### 별도 writable SPO fact store

SPO shape는 retrieval에 유용하지만, writable store가 되면 assertion/projection과 truth가 갈라진다.
materialized view가 더 안전하다.

### Hosted-style mandatory hooks

hooks는 유용하지만 local/offline/backend parity의 제약을 깨면 안 된다. agent hook은 optional, transparent,
auditable, removable이어야 한다.

### Recency-first conflict resolution

기술 프로젝트에서는 최신 정보가 맞는 경우가 많지만, 항상 그렇지 않다. 오래된 source가 더 권위 있을 수도 있고,
역사적 질문에서는 과거 fact가 정답일 수도 있다.

## 우선순위

| Priority | Initiative | 이유 |
|---|---|---|
| P0 | Trust policy engine + freshness contracts | 모든 memory expansion의 안전 기반 |
| P1 | Decision packets + negative memory | agentic development에서 가장 빠른 체감 가치 |
| P2 | Agent-session episode ledger + async outbox | session을 source-backed input으로 만드는 핵심 loop |
| P3 | Contradiction workspace + review batching | real-time extraction이 만드는 review debt 방지 |
| P4 | Materialized fact view + strict edge ontology | Hyper식 fact graph 장점을 duplicate truth 없이 흡수 |
| P5 | Bounded frontier retrieval | graph/context-map signal을 retrieval에 통합 |
| P6 | Identity lineage | graph density를 올리기 전 entity drift 문제 해결 |
| P7 | Transparent hook manager | trust-first onboarding과 hosted 제품 대비 차별화 |
| P8 | Outcome eval suite | retrieval hit rate보다 wrong-write/repeated-work/scope-leak을 측정 |
| P9 | 5-minute proof mode | 채택과 onboarding 개선 |

## 최종 판단

Hyper 스레드가 준 가장 좋은 아이디어는 "knowledge graph를 만들자"가 아니다. 그것은 이미 `mbrain`이 상당히
진행한 방향이다.

진짜 교훈은 다음이다.

1. memory system은 storage가 아니라 trust-maintenance product다.
2. agentic work에서 가장 가치 있는 memory는 결정, 실패, stale state, revalidation path다.
3. graph와 retrieval은 canonical evidence를 더 잘 찾게 해야 한다.
4. hooks와 connectors는 신뢰 UX 없이는 위험하다.
5. open/local/portable은 단순 구현 취향이 아니라 이 카테고리에서 강한 제품 포지션이다.

따라서 `mbrain`의 다음 문장은 이렇게 잡는 것이 좋다.

> MBrain is the open memory runtime for agentic work: portable like files,
> governable like Git, queryable like Postgres, and careful enough to show why it knows.

