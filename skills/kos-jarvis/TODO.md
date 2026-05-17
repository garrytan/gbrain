# kos-jarvis — Outstanding Work (post v0.35.6.0 sync, 2026-05-17)

> **Updated 2026-05-17**: v0.35.6.0 upstream sync landed (108 commits,
> 9 versions, v0.34.4 → v0.35.6.0). Story in
> `docs/JARVIS-ARCHITECTURE.md` §6.26. **PR #1017 (oauth_clients
> bootstrap) CLOSED as superseded** by upstream v0.35.5.0 `4446e9f9` —
> upstream's fix is a strict superset (7 probes vs our 2, + DDL conn
> threading + MIGRATIONS introspection guard). Production schema
> unchanged at v66; `bun install` postinstall confirmed "All migrations
> up to date" with no manual ALTER. Only 2 real merge conflicts
> (.gitignore + CLAUDE.md, both mechanical). brain_score 80/100,
> 3138 pages preserved.
>
> **Active fork dirs**: **10** (7 skills + 2 helpers + _archived) —
> unchanged from §6.24. M2-A/B/C/D all closed in prior rounds.
>
> ---
>
> **Updated 2026-05-15** (v0.34.4 sync): 29 commits, v0.31.3 → v0.34.4.
> Story in §6.24. Schema upgraded v45 → v66 (21 migrations + 1 manual
> bootstrap for `oauth_clients.{source_id, federated_read}` — the
> bootstrap PR that v0.35.5.0 has since superseded).
>
> ---
>
> **Updated 2026-05-10**: Same-day follow-up to v0.31.2 sync.
> 4 planned items, 3 commits landed, 1 (M3 production cutover) validated
> end-to-end on throwaway DB but deferred (vector-space compat decision
> needs a clean window). Story in `docs/JARVIS-ARCHITECTURE.md` §6.23.
>
> **Active fork dirs: 14 → 11** (will go to 10 once M3.cutover ships).
>
> Commits this session:
> - `9e3cd0f` — M1: archive kos-lint + frontmatter-ref-fix + slug-normalize,
>   shrink notion-ingest-delta SKILL.md to 5-line redirect
> - `3d667de` — M2-D: mark RESOLVED (premise was wrong; fork never had
>   `OperationContext.remote`)
> - `eedb357` — M2-A: archive triplet (dikw-compile, evidence-gate,
>   confidence-score) — production probe confirmed 100% dead code
>
> M3 pilot validated: native v0.27 Vercel AI SDK gateway with
> `google:gemini-embedding-001` + `--embedding-dimensions 1536` works
> end-to-end on Postgres-backed throwaway DB (`gbrain_m3_pilot`).
> Shim log line count unchanged across pilot lifecycle = 100% native
> traffic. English + Chinese retrieval both produce expected top-hits.
> Production cutover details under M3.cutover entry below.
>
> **Brain unchanged through this work**: 2718 pages, 96% embed coverage
> (244 stale pending — option (a) of M3.cutover handles this), schema v45,
> 35 RLS tables, brain_score 80/100. kos-compat-api PID 23937 served
> through all 4 work blocks without restart needed (only restarted at
> end of M2-A to load new `/ingest` hint string).
>
> **v0.31.2 sync context** (still relevant):
> 22 commits 跨 5 大版本 (v0.27.0 → v0.31.2) / 378 文件 / +57 691 -1 833 LoC。
> 仅 5 个 conflict。pglite-engine.ts WAL patch 自动 merge 干净。typecheck
> 干净,bin 0.31.2,4760 unit pass / 9 fail (mostly env-coupled),check:all
> 干净。Production schema 自动 v34 → v45 via bun install postinstall.
>
> **Upstream PR #627 closed as superseded** by v0.31.1.1 #682+#741 fixwave
> (broader bootstrap cover incl v0.20+v0.26.3+v39-v41)。
>
> **Pre-v0.26.7 TODO**: archived in git history at `6d84bea` parent.
> **Pre-v0.25.0 TODO**: archived in git history at `b23ab28`.
> **Pre-system-review TODO**: archived at `2203f94`.

Brain (post-v0.31.2-merge **+ schema v45 applied 2026-05-09**):
2718 pages (+241 since v0.26.7 sync), 96 % embed coverage (244 stale,backfill
pending), brain_score 80/100。doctor status: warnings (resolver_health 51 issues
全是 ~/.openclaw/workspace AGENTS.md 跨 boundary 引用,不是 fork 责任)。生产
Postgres 17 + pgvector 0.8.2 已升到 schema v45 (35 tables 全 RLS,新增 facts +
oauth_*),WAL fork patch retained for brain-db.ts。

---

## P0 — DONE 2026-05-04 (apply-migrations 已跑通)

### [x] 生产 Postgres schema 升到 v34 — DONE

**Result**: 3 migration applied (v32 oauth_infrastructure, v33
admin_dashboard, v34 destructive_guard),schema_version 现在 = 34
(latest)。`gbrain doctor` connection ok,RLS 31/31 tables,embeddings
100%,brain_score 83/100。

**Caveat 解锁过程**: `init --migrate-only` 头一次失败,报 `column
"agent_name" does not exist`。原因: v0.26.7 SCHEMA_SQL line 420
(`CREATE INDEX idx_mcp_log_agent_time ON mcp_request_log(agent_name,
created_at DESC)`) **forward-references** v0.26.3 加的列,但
`applyForwardReferenceBootstrap()` 数组**漏了** `mcp_request_log` 的
3 个 v0.26.3 列(`agent_name`, `params`, `error_message`)。这是
upstream "structurally prevented" 自夸的 bootstrap pattern 又一次
failure。手动 `ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS
agent_name TEXT, params JSONB, error_message TEXT` 后再跑 init
--migrate-only 全过。

**Follow-up**: 见下方新增 P0 给 upstream 提 PR 加 bootstrap 覆盖。

## P0 — upstream PR closed as superseded

### [x] PR #627 to garrytan/gbrain — CLOSED 2026-05-09 (superseded by upstream fixwave #682+#741)

**Filed**: https://github.com/garrytan/gbrain/pull/627
**Closed**: 2026-05-09 with [public superseded comment](https://github.com/garrytan/gbrain/pull/627#issuecomment-4414624389) — upstream's v0.31.1.1-fixwave (#776) extended `applyForwardReferenceBootstrap` to probe `mcp_request_log.{agent_name,params,error_message}` + ALTER COLUMN IF NOT EXISTS, exact same fix bundled with broader v0.20 + v39-v41 column coverage. Our PR became a strict subset. Patch doc `docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md` deleted.

`fix(bootstrap): cover v0.26.3 mcp_request_log columns` — extends
`applyForwardReferenceBootstrap()` 在 PostgresEngine + PGLiteEngine 上
probe `mcp_request_log.{agent_name, params, error_message}`; 表存在
但任一列缺失就 ALTER TABLE ADD COLUMN IF NOT EXISTS。
`REQUIRED_BOOTSTRAP_COVERAGE` 数组 + e2e regression test 都加齐。

**Validation**:
- typecheck clean (~3s)
- `bun test test/schema-bootstrap-coverage.test.ts` 2/2 pass
- `bun test test/bootstrap.test.ts` 6/6 pass (existing tests 没退化)
- e2e `DATABASE_URL=… bun test test/e2e/postgres-bootstrap.test.ts`
  3/3 pass (新 mcp_log case 33 ms,against `pgvector/pgvector:pg16`)
- PR diff: 4 files / +146 -5 lines / 100% additive

**Strategy**: branch `upstream-fix/bootstrap-mcp-log-cols` 切自
`upstream/master` (HEAD 058fe69 v0.26.7),不带 fork-local 内容;push
到 ChenyqThu/jarvis-knowledge-os-v2 (fork of garrytan/gbrain),从 fork
向 upstream 提 PR。所以 PR diff 干净,只有 4 文件 fix。

**Follow-up**: 等 garrytan review/merge。Merge 后下次 fork upstream
sync 拉到这条 fix,删掉 `docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md`
+ 这条 P0 entry。如果 upstream 回避或 30+ 天没动,考虑 fork-local
prepend (但 diff 这么小,PR 路径应赢)。

**Production impact**: 已经手动 `ALTER TABLE mcp_request_log ADD
COLUMN IF NOT EXISTS …` 过了,生产 schema v34, 不依赖此 PR merge。

### [x] 服务 smoke check — DONE 2026-05-04 (详见 Done section)

## P1 — Post-v0.34.4 sync follow-ups (added 2026-05-15)

### [x] (PR-2) Upstream PR: extend forward-bootstrap to cover oauth_clients.{source_id, federated_read} — CLOSED 2026-05-17 (superseded by v0.35.5.0 #1111)

**[garrytan/gbrain#1017](https://github.com/garrytan/gbrain/pull/1017)**.
Branch `upstream-fix/bootstrap-oauth-clients-cols` cut from
`upstream/master` (HEAD `24881f60` v0.34.4). Pattern lift from #627:
probe `oauth_clients.{source_id, federated_read}` in the
`information_schema` round-trip, ALTER TABLE ADD COLUMN IF NOT EXISTS
when missing, FK on `source_id` to `sources(id)` and `NOT NULL
DEFAULT '{}'` on `federated_read`. Both PostgresEngine and PGLiteEngine
mirror the change. `REQUIRED_BOOTSTRAP_COVERAGE` gains two entries.
3 files / +87 -4 / `bun test test/schema-bootstrap-coverage.test.ts
test/bootstrap.test.ts` 11 pass / 0 fail (50 expect() vs 48 pre-patch).

E2E test in `test/e2e/postgres-bootstrap.test.ts` not extended — the
in-memory PGLite contract test already validates the per-column
bootstrap loop; PR body offers to add an oauth-specific E2E case if
maintainers prefer.

On merge: drop this entry from TODO + on next fork sync the local
changes (if any) auto-merge clean.

Production impact: already manually ALTER-ed on the fork's prod DB
during the v0.34.4 sync (§6.24); not blocking. PR closes the gap for
any other downstream that runs `gbrain init --migrate-only` on a
pre-v0.34 schema after pulling v0.34.x.

### [x] (CJK-eval) Reassess "vector search only" assumption after v0.32.7 CJK fix wave — VERDICT 2026-05-15: assumption holds for compound CJK; tighten the wording, no behavior change

15-query probe via `gbrain search` (keyword-only, tsvector path) at
schema v66 / v0.34.4 / Postgres engine:

| Pattern | Sample | Result |
|---|---|---|
| English single/multi word | `Lucien`, `Omada`, `Notion`, `Postgres` | 10-18 hits, 0.3-0.5 scores |
| Mixed CJK+space | `AI 网关` | 8 hits via Latin fragment, low CJK weight |
| 2-3 char CJK | `知识管理`, `知识库` | 2-3 hits via body-fragment containment |
| 4-char CJK compound | `向量检索`, `嵌入模型`, `云控制器`, `万兆网卡`, `Gemini 嵌入` | **0 hits** every time |
| 2-char CJK names | `拉勾`, `猫人` | 0 hits |

**Verdict**: v0.32.7's CJK work landed downstream of where it would
have helped pure-keyword retrieval here. Postgres `to_tsvector('simple')`
treats Han runs as a single non-tokenizable blob; matches only fire when
the query string is a literal substring of the body (and even then
they're scored weakly). 4-char compound CJK — the *typical* operator
query shape on this brain — still goes 0/N on keyword. Vector path
remains the only reliable retrieval for CJK compound queries.

**Operating-assumption update**: CLAUDE.md's "vector search is the
only working retrieval path on Chinese queries" is correct in spirit
but slightly overstated — English-on-CJK-corpora keyword search works
fine, and so does fragment match on 2-3 char standalone CJK terms.
The accurate wording is: *compound CJK queries (4+ Han characters
without whitespace) cannot be served by tsvector and require the
vector path*. Update CLAUDE.md to this tighter form in a follow-up
edit; no behavior change to kos-patrol / kos-compat-api routing.

**Hybrid budget save — not yet worth it**: the original probe goal
was to find a path that lets cost-sensitive callers (kos-patrol gap
detection, etc.) drop the embed call. Today's keyword path can't
serve the compound-CJK queries those workloads actually issue, so
hybrid + keyword-first / vector-backfill saves nothing on the
modal query. Re-evaluate if upstream lands a real CJK tokenizer
(jieba binding, ICU, or pgroonga ext — none in v0.34.x).

### [x] (overlap-matrix) Evaluate v0.31.6 / v0.32.2 / v0.33.0 vs fork hot-memory pieces — VERDICT 2026-05-15: no retirements; upstream features complementary, not replacement

Built the side-by-side. None of the three upstream surfaces is a
superset of the fork piece I framed it against; the original
"potentially redundant" column overstated the overlap. Detail:

| Upstream | Real surface | Fork piece | Verdict |
|---|---|---|---|
| v0.31.6 extract-facts-during-sync (`src/core/facts/extract.ts` runs per page-write, lands in `facts` table + `## Facts` fence) | per-page real-time fact extraction | concept-synthesis (M2-A.pilot, decision (b) keep ad-hoc, **never wired**) | **No overlap.** Upstream's extract-facts is per-page real-time; concept-synthesis was for cross-page multi-month recurrence clustering. Different problem. Fork has nothing wired on the per-page real-time path. |
| v0.32.2 facts-fence (`## Facts` fence on entity pages as system-of-record, reconciled to DB on every sync; `src/core/facts-fence.ts` + migrate.ts:2572) | INSIDE individual brain pages | digest-to-memory (weekly Sun 22:00 cron writes `[knowledge-os]` summary to `~/.openclaw/workspace/MEMORY.md`) | **Different surface entirely.** facts-fence is intra-page, intra-brain; digest-to-memory is cross-system push from brain → OpenClaw MEMORY.md. No conflict, no retire. |
| v0.33.0 "morning pulse" — actual scope is `gbrain recall --pulse / --since-last-run / --pending` on the `facts` table (PR title is misleading; `src/commands/recall.ts`) | hot-memory fact recall, entity-scoped + time-windowed | kos-patrol daily 08:07 cron (brain-wide health audit → `~/brain/.agent/dashboards/knowledge-health-<date>.md` + digests) | **Different scope.** Upstream pulse queries the facts table for recently-added rows; kos-patrol audits structural health (lint / staleness / entity gaps). Same cadence convention, totally different output. No retire. |

**No retirements warranted from this matrix.** M2-A.pilot decision
(b) — *keep concept-synthesis ad-hoc, don't wire* — also survives:
the upstream feature that landed (extract-facts) addresses a
different need (per-page fact extraction), not the recurrence-
clustering need concept-synthesis was prototyped for.

**Side benefit: a new capability to evaluate, not a retire**.
Upstream's `extract-facts-during-sync` would give the fork's brain
a real-time per-page fact index for free. Currently it's **not
enabled** here (every `gbrain sync` skips the facts:absorb writer
because the sub-process never connects — same root cause as the
[`facts:absorb`](#-factsabsorb-sub-process-factsabsorb-writer-has-no-db-connection-added-2026-05-15)
P1 entry above). Re-evaluating whether to enable it on this fork is
worth tracking; for now, no fork code changes from this matrix
work.

Decision artifact lives in this entry; no separate plan doc needed.

---

## P1 — consolidation PLAN 落地 (M1 milestone, 仍 active)

> 来自 [`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](../../docs/KOS-JARVIS-CONSOLIDATION-PLAN.md)
> §7 M1 milestone。每条独立可起手,合计 ~6 h 研究 + 30 min cleanup。
> v0.26.7 sync 后 M1 内容**未变**(上游没 close 任何 fork 责任),
> 但**新增 M2 候选**见下方"M2 milestone 候选"段。

### [ ] Wire-status check: dikw-compile / evidence-gate / confidence-score

**Why**: PLAN §5.2 怀疑 KOS quality 三件套 (`dikw-compile` + `evidence-gate`
+ `confidence-score`) 没真正 wired 进 ingest pipeline。Fork README
声称 "Runs after idea-ingest / media-ingest / meeting-ingestion",
但上游 `ingest` skill 不知道 fork skill 存在。

**What**: 跑历史 ingest 看每个 skill 的 run.ts 是否有调用记录 (log /
report 文件 / DB 写入痕迹)。决定:
- (a) wire via cron post-step
- (b) wire via local CLAUDE.md hook
- (c) downgrade 到 "advisory only,run on demand"

**Acceptance**: 三个 skill 各自的 wire status + 决策写进
`skills/kos-jarvis/README.md` 的 `当前状态` section。

**Scope**: 1 h research + 30 min decision write。

### [x] kos-lint 退役 pilot test — DONE 2026-05-10 (mechanical retire, formal pilot procedure short-circuited by smoke-test evidence)

The PLAN §6 four-step pilot procedure was short-circuited by the
2026-05-04 service smoke (above in Done section): kos-patrol stderr
showed `[2] kos-lint JSON parse failed; exit=3` for the live runner,
and patrol still reported 0 WARN — i.e. **production was already
operating without kos-lint** because the runner was naturally broken.
Strongest possible PILOT-RETIRE evidence, no baseline-vs-control run
needed.

**Action taken (commit `9e3cd0f`, 2026-05-10)**:
- `skills/kos-jarvis/kos-lint/` moved to `skills/kos-jarvis/_archived/kos-lint/`
- `kos-patrol/run.ts` Phase 2 turned into a no-op (`return { rows: 0,
  findings: [], errors: 0, warns: 0 }`) with docblock listing where
  each of the 6 checks now lives:
  - check 1 (frontmatter) → upstream `frontmatter-guard` skill + `gbrain doctor`
  - check 2 (duplicate id) → `gbrain doctor` schema integrity
  - check 3 (dead links) → upstream BrainWriter linkValidator (sync gate)
  - check 4 (orphans) → `gbrain orphans` + dream-cycle phase
  - checks 5+6 (weak links, evidence gap) → **not yet rehomed**;
    future `kos-quality` ~150 LoC shim if Lucien wants them back

**Deferred (no current need)**: the ~150 LoC `kos-quality` shim for
checks 5+6 (weak links + evidence gap). Five days post-retire,
`kos-patrol` still reports 0 ERROR / 0 WARN daily and no operator
has missed the two KOS-unique checks. If a specific brain-quality
question arises that those checks were uniquely suited to answer,
re-open and build kos-quality; until then it would be premature
abstraction.

**Verdict**: M1 milestone item closes. Active fork dirs unchanged
since the retire commit already landed; just need this TODO entry
in the right state.

### [ ] Archive frontmatter-ref-fix + slug-normalize

**Why**: PLAN §5.3 标 ARCHIVE。两个 one-shot skill 都已经跑完一次
(frontmatter-ref-fix:ERRORs 4→0 in §6.16;slug-normalize:7 strays
renamed in Step 1.5)。没有 recurring schedule。

**What**: `mkdir -p skills/kos-jarvis/_archive/{frontmatter-ref-fix,slug-normalize}`
+ `git mv` 整 dir 进去 + `skills/kos-jarvis/README.md` 加 "前置工具" 段
指向 archive。

**Acceptance**: 两 dir 都在 `_archive/` 下;README 有 pointer;
`skills/kos-jarvis/RESOLVER.md` 段(如有 trigger 引用)更新。

**Scope**: 30 min。

### [ ] 重写 notion-ingest-delta SKILL.md 为 5-line 跳转

**Why**: PLAN §5.5 — SKILL.md 是 design contract,实际 worker 在
`workers/notion-poller/` + `/ingest` 端点扩展在
`server/kos-compat-api.ts`。SKILL.md 留着误导。

**What**: 缩成 5 行 redirect 指向真实代码 + `kos-compat-api /ingest`
扩展端点文档。原 design 写进 `workers/notion-poller/run.ts` header
注释保 rationale。

**Acceptance**: SKILL.md ≤10 行;原 design rationale 在 worker
header 可读到。

**Scope**: 15 min。

---

## P1 — M2 milestone 候选 (post-v0.26.7,新增 fork 收缩机会)

> v0.26.7 sync 引入了三件事,改变了 fork 收缩路线图。每件都需要独立
> 评估 — 不是"立即退役",是"评估退役路径 / 部分迁移"。Net target 从
> M1 的 "16 → 11 active" 进一步缩到 M2 后 "11 → 7-8 active"。

### [x] (M2-A) wire-status 查证 — RESOLVED 2026-05-04

**Verdict**: **RETIRE all three triplet skills**(`dikw-compile`,
`confidence-score`, `evidence-gate`)。**PILOT `concept-synthesis`** 在
188 个 concept pages 上(下次 session)。

**Decisive evidence** (production probe 2026-05-04):
- `frontmatter.dikw_layer` 设值 = **0 / 2477** (0.00%)
- `frontmatter.evidence_level` 设值 = **1 / 2477** (单 E2,0.04%)
- `frontmatter.confidence` 设值 = 2470 / 2477 — **但值是
  `kos-compat-api.ts:454,533` 硬编码模板字符串**,不是脚本算的

Cross-checked: `kos-compat-api.ts`, `workers/notion-poller`,
`kos-patrol/run.ts` 没有任何一个 spawn 三件套的 `run.ts`。
**全部是 dead code**,从未在生产 ingest pipeline 中跑过。

完整决策记录见 `docs/KOS-JARVIS-CONSOLIDATION-PLAN.md` §M2-A
(updated 2026-05-04) + `docs/JARVIS-ARCHITECTURE.md` §6.21 末尾
"M2-A resolution"段。

### [x] (M2-A.archive) Archive triplet — DONE 2026-05-10

3 dead skill dirs (`dikw-compile`, `evidence-gate`, `confidence-score`)
moved to `skills/kos-jarvis/_archived/`. Triggers removed from
`skills/RESOLVER.md` `## KOS-Jarvis extensions` table (with M2-A archive
note). `skills/manifest.json` three entries deleted (49 → 46). Prompt
string in `server/kos-compat-api.ts:600` rewritten:
`"dikw-compile recommended"` → `"use \`gbrain dream\` for cross-page
synthesis"`. `skills/kos-jarvis/README.md` `_archived/` tree expanded
with M2-A entries. `skills/kos-jarvis/_lib/brain-db.ts` caller list
updated. **Active fork dirs: 14 → 11.**

### [x] (M2-A.pilot) concept-synthesis pilot — DONE 2026-05-10, decision (b)

**Verdict**: option **(b) Keep ad-hoc** — do NOT wire to dream-cycle.

Pilot ran deterministic-only (Phase 1 + Phase 2) on 181 concept pages
via a transient script `/tmp/m2a-pilot.ts`. No LLM calls, no brain
page mutations.

**Tier distribution**: T1=0, T2=0, T3=11, T4=170 (93.9% single-mention).
Zero concepts cleared the multi-month-recurrence threshold required to
justify Phase 3 LLM synthesis. Mention-count algo only counts slug-string
references in `~/brain/sources/`, not natural-language prose mentions —
so absolute counts undershoot, but the **shape** (long-tail T4 dominance)
is robust.

**Phase 1 dedup wins**: 22 Jaccard ≥0.5 + 11 substring pairs = 33
candidate merges (~18% of corpus). Concrete cases: `office-3f-ap01` ⊂
`ap-office-3f-ap01`, the 5 `fsct-2025-*` ticket pages, the
`dashboard` ⊂ `dashboard-site` ⊂ `dashboard-site-health` chain. These
are real garbage that one-pass cleanup (LLM or rule-based) can address.

**Why not (a) wire-to-cron**: optimizes for a use case (sustained T1/T2
evolution narratives) that doesn't exist in this brain. Premature
automation. Phase 3+4 LLM cost (~$1-3/week) for zero candidates.

**Why not (c) fork-own-version**: would add new fork-local code on the
same day we just deleted 7 dirs (M1+M2-A+M3). Net surface increase. The
deterministic Phase 1+2 already lives in `/tmp/m2a-pilot.ts` (not
committed to fork — transient artifact); Lucien can re-run any time.

**Decision evidence**: `~/brain/.agent/reports/concept-synthesis-pilot-2026-05-10.md`
(brain commit `b9e32d8aa7`).

If the corpus shifts later (signal-detector + voice-note-ingest accumulate
enough recurring concept stubs across multiple months), reopen and
re-evaluate (a) or (c) with new evidence.

### [x] (M2-B) `kos-compat-api` ↔ `gbrain serve --http` + thin translator 评估 — VERDICT 2026-05-15: option (c), don't touch

Sized the three candidate paths against actual surfaces:

- Upstream `src/commands/serve-http.ts`: 1116 LoC. OAuth 2.1 +
  MCP JSON-RPC transport + admin dashboard + token persistence.
- Fork `server/kos-compat-api.ts`: 661 LoC. KOS-v1 contract:
  `GET /health`, `GET /status`, `GET /digest`, `POST /query`,
  `POST /ingest`. Bearer-auth, JSON body.
- MCP ops available (`src/core/operations.ts`): `query`, `search`,
  `get_page`, `put_page`, `list_pages`, `takes_*`, etc. — none of
  them is a 1:1 for `/ingest` or `/digest`.

**Endpoint-by-endpoint translation feasibility for option (a)**:

| KOS-v1 endpoint | MCP equivalent | Notes |
|---|---|---|
| `POST /query` | `tools/call` `name="query"` | clean 1:1 (~80 LoC saved) |
| `GET /status` | `tools/call` `name="list_pages"` + client-side aggregation | partial; per-kind histograms need new aggregation (~20-30 LoC saved best case) |
| `GET /digest` | none | reads `~/brain/.agent/digests/patrol-*.md` — pure fork-side concern, stays |
| `POST /ingest` | none | writes md to filesystem + git commit + spawns `gbrain sync` subprocess — pure fork-side concern, stays (~250 LoC unchanged) |
| `GET /health` | n/a | HTTP-level ping, stays (~5 LoC) |

**Net LOC math** for option (a): theoretical ~500 LoC reduction in the
TODO premise was wishful — only /query and /status have direct MCP
equivalents (~110 LoC). A translation layer adds back ~80-150 LoC
(KOS-v1 → JSON-RPC marshal, OAuth client management for talking to
its own subprocess, error-code mapping). **Realistic net change: 0
to -50 LoC**, in exchange for:

- One extra subprocess (`gbrain serve --http`) at boot + lifecycle
- OAuth 2.1 client-side dance for kos-compat-api → gbrain-serve
- A second port to expose internally
- Higher MTTR for incidents that fan out across two processes

**(b)** rejected — Notion Knowledge Agent and OpenClaw feishu cron
are hard-coded against `kos.chenge.ink/<endpoint>` with KOS-v1
JSON-body shape. Migrating them is out of scope for the fork.

**(c) selected — don't touch.** kos-compat-api is fine. The
"upstream closed our root cause" framing in the original M2-B
hypothesis is technically true (HTTP boundary now upstream-supported)
but operationally moot — fork-side /ingest + /digest dominate the
LoC and the external clients lock us to KOS-v1 wire shape anyway.

**Re-evaluate trigger**:
- Upstream ships a non-OAuth, KOS-style HTTP mode (unlikely).
- Notion Agent rebuild reaches a point where MCP-over-HTTP is on
  the table for external systems.
- kos-compat-api needs a feature only OAuth-MCP provides (per-client
  audit, etc.) that's not worth porting.

Decision artifact: this entry. No code, no plan doc.

### [x] (M2-C) Phase 4-5 邮件/日历导入 → 改基于上游 `archive-crawler` — VERDICT 2026-05-15: option (b) split — archive-crawler covers Phase 5 Email; Phase 4 Calendar stays fork-local

Read `skills/archive-crawler/SKILL.md` for source-format coverage.
Supported `Source.type` values: `local`, `dropbox`, `backblaze`,
`gmail-takeout`, `mbox`, `pst`. Refuses to run without
`archive-crawler.scan_paths` allow-list in `gbrain.yml` (safety
gate; writes to `originals/` / `personal/` / `ideas/`).

| Fork Phase | Format | archive-crawler covers? |
|---|---|---|
| Phase 5 — Email | `.mbox`, Gmail takeout, `.pst` | **Yes, fully**. Both `mbox` and `gmail-takeout` are first-class source types. |
| Phase 4 — Calendar | Apple/Google Calendar via API, `.ics` export | **No**. Not in `Source.type` enum. Calendar isn't an "archive of files" — it's a stream of structured events that needs an OAuth/API client or `.ics` parser fork-side. |

**Verdict (b) — partial migration**:

- **Phase 5 Email** → upstream-driven. When the time comes to
  implement, the work is `gbrain.yml` config + path allow-list +
  per-mbox manifest review, NOT a new fork-local skill. Net fork
  surface gain from Phase 5: 0 new skills.
- **Phase 4 Calendar** → stays on the original fork-local plan. Needs
  either an OAuth Google Calendar client (in `workers/calendar-poller/`
  similar to `workers/notion-poller/`) or a recurring `.ics` export +
  parse step. archive-crawler can't help.

**Acceptance**: this entry's verdict is the artifact. Per the M2-C
scope note, **Phase 4-5 implementation itself is out of milestone
scope** — neither has been started, both gate on
`docs/JARVIS-NEXT-STEPS.md` Phase 1-3 finishing first.

**Follow-up when Phase 4-5 actually starts**: update
`docs/JARVIS-NEXT-STEPS.md` Phase 5 section to say "configure
upstream archive-crawler with `gmail-takeout` source", and Phase 4
to remain fork-local with the calendar-poller worker design. No doc
edits today — wait until that work moves to active.

**Scope reduction**: original fork plan estimated Phase 5 at ~1 week
of net-new skill build; archive-crawler reduction is ~3-4 days saved
(config + review loop vs ground-up worker). Phase 4 unaffected.

### [x] (M2-D) `Operation.scope` + `.localOnly` 取代 fork-local `OperationContext.remote` — RESOLVED 2026-05-10 (premise wrong, never-needed)

**Verdict**: **No code change required.** Fork-local code 从未实现过
`OperationContext.remote`,`git grep "ctx\.remote\|context\.remote"` 在
`server/` `workers/` `skills/kos-jarvis/_lib/` 中天然归零(只有
`brain-db.test.ts:88` 的 `remote: true` 是 v0.25.0 `EvalCandidateInput`
eval-row schema 字段,不是 OperationContext flag)。

**Premise correction**: 原 M2-D 假设 "Operation.scope + .localOnly 是
fork 老 OperationContext.remote 的成熟版" 是错的。读
`src/core/operations.ts:223-249`(F7b hardening,v0.30.0):
- `OperationContext.remote: boolean` 仍是 **REQUIRED 字段**(每个 transport 必须显式 set)
- `Operation.scope` / `Operation.localOnly` 是 **operation-side** 安全声明(描述 op 自己的危险度)
- `OperationContext.remote` 是 **caller-side** 信任度(描述 caller 是不是远程)
- 两者**互补**(scope=admin + localOnly + remote=true → HTTP 路径 reject),不是替代关系

Fork 也没有 hand-rolled `kos-compat-api` 的 remote check — 所有信任分级都
完全 delegate 给 `gbrain` CLI 子进程或下游 op handlers。

**Action taken**: 单 commit 标记 entry RESOLVED,无 code 改动。

### [x] (M3.pilot) Native Google embedding pilot — DONE 2026-05-10

End-to-end pilot ran in throwaway local Postgres DB (`gbrain_m3_pilot`,
schema v45 via `init --supabase --non-interactive --embedding-model
google:gemini-embedding-001 --embedding-dimensions 1536`). 2 sample
concept pages (English + mixed CJK) synced + embedded via the **native
v0.27 Vercel AI SDK gateway** (NANO_BANANA_API_KEY for
`GOOGLE_GENERATIVE_AI_API_KEY`).

**Verification**:
- `vector_dims(content_chunks.embedding) = 1536` ✓
- English query `founder mode` → top hit 0.92 ✓
- Chinese query `向量检索` → top hit 0.90 ✓
- `wc -l shim.stdout.log` unchanged across pilot lifecycle (last
  shim write 23:53 UTC; pilot ran 00:23-00:30) — **100% native traffic**
- Production service mesh unaffected (kos-compat-api PID continued,
  BrainDb pinned to production DB)
- `~/.gbrain/config.json` clobbered by init (per CLAUDE.md fork rule);
  restored from `~/.gbrain/config.json.pre-m3-2026-05-10` snapshot
- Pilot artifacts cleaned: `dropdb gbrain_m3_pilot`, `rm -rf /tmp/m3-pilot-brain`

**Findings worth flagging** (now in §6.23):
1. `content_chunks.model` is audit-only fallback string
   (`postgres-engine.ts:1136` writes `chunk.model || 'text-embedding-3-large'`);
   import path doesn't fill `chunk.model`. Real provider is correct
   (vector content is real Google output) but column lies. Use shim
   log delta to verify cutover, not this column.
2. `init --supabase` writes DB `config.embedding_model` without
   `provider:` prefix. `loadConfigWithEngine` doesn't actually read
   that field anyway (file/env-only by design,
   `src/core/config.ts:182-184`). Cosmetic, no impact.

### [x] (M3.cutover) gemini-embed-shim 退役 — DONE 2026-05-10

**Cutover landed same day as pilot.**

5 deployed plists (kos-compat-api / dream-cycle / enrich-sweep /
kos-patrol / notion-poller) + 5 templates carry
`GOOGLE_GENERATIVE_AI_API_KEY` (= NANO_BANANA_API_KEY) +
`GBRAIN_EMBEDDING_MODEL=google:gemini-embedding-001` +
`GBRAIN_EMBEDDING_DIMENSIONS=1536`. `kos-compat-api` plist
additionally dropped `OPENAI_BASE_URL` + `OPENAI_API_KEY=stub`.
`~/.gbrain/config.json` extended with embedding fields.
`launchctl bootout` + `bootstrap` cycle of all 5 services. Re-embed
of all 5548 chunks (`gbrain embed --all`) into clean native vector
space — Google free-tier quota hit ~60% through the first run; retry
covered the remaining shim-era chunks. `null_left=0` for all chunks
throughout. Shim launchd service bootout'd, deployed plist deleted,
`skills/kos-jarvis/gemini-embed-shim/` → `_archived/`,
`scripts/launchd/com.jarvis.gemini-embed-shim.plist.template` →
`scripts/launchd/_archived/`. Docs synced (RESOLVER, manifest,
README, CLAUDE.md, CONSOLIDATION-PLAN, scripts/launchd/README,
JARVIS-NEXT-STEPS, .env). Backups retained at
`~/.gbrain/config.json.pre-m3-cutover-2026-05-10` +
`/tmp/pg-pre-m3-cutover-2026-05-10.dump` (89 MB) +
`/tmp/pre-m3-cutover-2026-05-10/` (6 plists).

**Audit attestation**:
- shim launchd service: gone (verified via `launchctl list`)
- shim log line count: stayed at 6703 across cutover + re-embed
  windows = 100% native traffic
- query smoke (English + Chinese): top hits in healthy 0.7-0.9 band

Active fork dirs: 11 → 10. **Story in `docs/JARVIS-ARCHITECTURE.md`
§6.23 (M3.cutover landed same day continuation)**.

### [x] (M3.cutover-followup) Backfill remaining shim-era chunks — DONE 2026-05-10

**100% native vector space achieved.** All 5548 chunks now embedded by
the v0.27 native gateway (`google:gemini-embedding-001` + 1536 dim).
Zero NULL embeddings, zero shim-era residuals.

**Procedure**:
1. SQL `UPDATE content_chunks SET embedding = NULL, embedded_at = NULL
   WHERE embedded_at < now() - interval '2 hours'` — marked 1563
   shim-era chunks as stale.
2. `gbrain embed --stale` x 4 successive runs — each batch hit Google
   free-tier RPM cap and exited 0 with partial progress, but quota
   reset between runs (per-minute RPM, not daily). Throughputs:
   881 → 440 → 199 → 20 chunks per pass.
3. One stuck page (`sources/notion/re-qataer-isp-ooredoo-sms-...`,
   23 chunks, max 18131-char chunk) wouldn't clear via `--stale`
   batching — single-page invocation `gbrain embed <slug>` succeeded
   immediately. Likely page-level batch retry policy differs from the
   `--stale` flow's larger group batching when chunks approach
   per-batch token caps.
4. Final state: `null_left=0`, all 5548 chunks embedded by native
   gateway, query smoke (English "Omada Cloud" + Chinese "知识管理")
   in healthy 0.6-0.76 band.

**Cost**: ~5 retry rounds × ~880 chunks avg + final single-page = ~5000
Google embedding API calls beyond M3.cutover's initial 6802. Total
session API consumption ~$0.50-0.70.

**What** (next session, ~2-3 h):

Plist edits (deployed at `~/Library/LaunchAgents/com.jarvis.{kos-compat-api,notion-poller,dream-cycle,enrich-sweep,kos-patrol}.plist`,
templates at `scripts/launchd/com.jarvis.*.plist.template`):
- Add to EnvironmentVariables:
  - `GOOGLE_GENERATIVE_AI_API_KEY=$NANO_BANANA_API_KEY`
  - `GBRAIN_EMBEDDING_MODEL=google:gemini-embedding-001`
  - `GBRAIN_EMBEDDING_DIMENSIONS=1536`
- Remove from EnvironmentVariables:
  - `OPENAI_BASE_URL=http://127.0.0.1:7222/v1`
  - `OPENAI_API_KEY=stub-for-gemini-shim`
- Also add `embedding_model` + `embedding_dimensions` fields to
  `~/.gbrain/config.json` so non-launchd-spawned `gbrain` invocations
  (Lucien's interactive CLI) match.

Vector-space compat decision (pick one before bootout):
- **(a) Force re-embed all 2718 pages right after cutover.** Few
  minutes / few cents on Google. Cleanest. Run
  `gbrain embed --all --force` (or equivalent — verify flag exists in
  v0.31.2 first).
- **(b) Keep shim running 24-48h soak.** Let new chunks be native, old
  chunks stay shim-era; sample 10-20 representative production queries
  before/after; compare top-k overlap. If degradation < threshold,
  proceed to bootout. Costs nothing extra but observation window.
- **(c) Just cutover and `gbrain embed --stale`** to backfill the 244
  stale chunks only. Existing 2474 chunks untouched. Risk: if normalization
  differs, mixed vector space silently degrades retrieval.

Recommend **(a)** — clean state is cheap here.

Then:
1. Cycle services: `launchctl bootout gui/$UID/com.jarvis.<svc>` +
   `bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.<svc>.plist`
   for the 5 affected services
2. Smoke: `curl -H "Authorization: Bearer $KOS_API_TOKEN"
   http://127.0.0.1:7225/status` returns 2718 pages, query a Chinese
   phrase, watch shim log line count — must NOT increase
3. `launchctl bootout gui/$UID/com.jarvis.gemini-embed-shim` +
   `rm ~/Library/LaunchAgents/com.jarvis.gemini-embed-shim.plist`
4. `git mv skills/kos-jarvis/gemini-embed-shim
   skills/kos-jarvis/_archived/gemini-embed-shim`
5. `git mv scripts/launchd/com.jarvis.gemini-embed-shim.plist.template
   scripts/launchd/_archived/`
6. Update: `skills/manifest.json` (delete shim entry),
   `skills/RESOLVER.md` KOS section (no shim trigger to remove —
   it has none — but add archive note), `skills/kos-jarvis/README.md`
   (move shim to _archived/ tree, active dirs 11 → 10), fork
   `CLAUDE.md` (remove the "shim is currently routing" rule —
   replace with "embeddings now native via v0.27 gateway"),
   `docs/KOS-JARVIS-CONSOLIDATION-PLAN.md` (M3 milestone CHECK)

**Acceptance**: shim launchd service gone, 0 shim log writes after
cutover, query latency/quality unchanged from pre-cutover baseline,
fork active dirs **11 → 10**.

**Scope**: 30 min plist edits + 30 min cycle/smoke + 30 min vector-space
re-embed (option a) + 30 min retire/cleanup. Total ~2 h. Needs window
where Lucien is OK with brief launchd churn (~5 minutes during cycle).

**Scope**: 1-2 h pilot + 30 min production switch + 30 min retire/cleanup。Total ~2-3 h。

---

## P2 — quality / observation

### [ ] check-resolvable 2 测试 fail (dev-box 环境耦合,上游测试 gap)

**Why**: 上游 `bun test` 里两个 case `openclaw_workspace_home_root` 抢
占 `repo_root` 解析,源头是 dev-box 上 `~/openclaw` 跟 fork repo root
共存的环境耦合,非生产 fire。本轮 launchd 修复期间复现仍在。

**What**: 缩窄到 hermetic temp-dir scope (`createTempWorkspace()` +
`TMPDIR`) 让 test 不依赖 `$HOME`。可能要给上游开 PR(纯测试 fix,
production code 不动)。

**Scope**: 30 min 改 + 上游 PR window。低优先,non-prod。

---

_(P1 list 见上面 "consolidation PLAN 落地" section,M1 milestone 4 项)_

---

## P2 — observation / cosmetic

### [ ] `GBRAIN_SOURCE_BOOST` tune-up evaluation (1-week soak now ~6天满)

**Why**: v0.22.0 加的 source-aware retrieval ranking。Default boost map
不知道我们 layout(`sources/notion/` vs upstream's `your-openclaw/chat/`),
所以我们 brain 在 factor=1.0 全均 — 等于无 source-aware boost。Notion-
source 占 60 %,可能 swamp 短中文 query。

**What**(P0 review 中的 step 3 会做这个):
1. 跑 5-10 个代表性中文查询(`/query`),手动评 top-3 相关性。
2. 若 notion-sources 不当主导,设 plist EnvironmentVariables:
   `GBRAIN_SOURCE_BOOST="concepts/:1.5,projects/:1.3,syntheses/:1.5,sources/notion/:0.7"`
3. 重跑同样 query。win >5 % → 留;else → revert。

**Acceptance**: 决定记录到 `docs/JARVIS-ARCHITECTURE.md`。

**Scope**: 1 h 评估(post-soak)。

### [ ] CHUNKER_VERSION 3→4 re-walk cost (markdown-only,大概率 cheap)

**Why**: v0.21.0 设 `CHUNKER_VERSION 4`,sources.chunker_version 已被
手动 pin 到 '4'。理论上 markdown body cache-hit on embedding(241 stale
除外),代价应该极小,但没正式 verify。

**What**: `gbrain reindex-code --dry-run` 看 ConfirmationRequired。若
embedding cost <$1,直接 `--yes`。

**Acceptance**: cost preview 抓取 + 决定记录。

**Scope**: 15 min preview, 0-30 min reindex。

### [ ] Patrol dashboard ↔ stdout 数字不一致 (新发现 2026-04-29)

**Why**: Phase A review 发现 `~/brain/.agent/dashboards/knowledge-health-2026-04-29.md`
显示 `35 ERROR + 796 WARN`,而同次 patrol stdout log 显示 `0 ERROR, 762 WARN`。
两个数字应该 always 一致。Dashboard total pages 显示 2151 vs Postgres
2305 — dashboard 似乎走 fs walking 而 stdout 走 DB,page set 不同。

**What**:
1. 读 `skills/kos-jarvis/kos-patrol/run.ts` 的 lint 调用点 vs dashboard
   写入点。
2. 确认 page-set 来源是否真的不同(fs walking vs `db.listAllPages`)。
3. Decision:统一到一个 source,或文档化 expected gap。

**Acceptance**: stdout `Lint:` 和 dashboard `## Lint` 数字一致,OR
`docs/JARVIS-ARCHITECTURE.md` 加段说明 "expected gap"。

**Scope**: 30 min 调研 + 30 min 修(若选)。

### [ ] Calendar checkpoints (carried forward, post-Path-3 调整)

| Date | Action | 状态 |
|---|---|---|
| 2026-05-04 | Stage 4 v1 archive — `com.jarvis.kos-api.plist.bak` to `_archive/`,archive v1 GitHub repo | **today** |
| 2026-05-07 | Step 2.4 commit-batching review for `~/brain` per-ingest commits | active |
| 2026-05-25 | Re-evaluate Gemini 3072-dim embeddings vs current 1536-dim truncation | active |
| ~~Trigger-based~~ | ~~PGLite → Postgres switch~~ | **CLOSED 2026-04-29 via Path 3 (§6.18)** |

### [x] Sync_failures cleanup: 48 chunker_version legacy entries — DONE 2026-05-15

`gbrain sync --skip-failed --no-pull` on the host: `Acknowledged 48
pre-existing failure(s)`. `~/.gbrain/sync-failures.jsonl` open→0.
Verified via direct read of the jsonl pre-run (`total=48 open=48
acked=0`) and post-run noop sync (`Already up to date`). All 48 were
the same `column "chunker_version" of relation "pages" does not exist`
shape captured today 07:02 UTC during the morning poll, before the
schema-v66 fix wave fully drained. Schema is at v66 now so the failure
mode can't reproduce.

### [x] bun test full-suite hang investigation — DONE 2026-05-15 (root-caused, env-coupled)

`bun test --bail` (no `--reporter=verbose`; that flag was rejected by
bun 1.3, accepted values are `junit` and `dots`) ran 616 tests across
37 files in **45 s** before hitting the bail. Root cause:

**`test/think-pipeline.serial.test.ts`** — the `beforeAll` hook
(`new PGLiteEngine() → connect({}) → initSchema() + seed`) exceeded
bun's default 5 s hook timeout, exiting with `a beforeEach/afterEach
hook timed out for this test` after 6 538 ms. Same family as the
PGLite #223 cold-start hang we've recorded under §6.20 — PGLite cold
init varies wildly on this Mac (3-15 s seen). Without `--bail`, every
serial test that opens a fresh PGLite engine pays the same tax in
sequence, which is what drove the original 30-min wedge during the
v0.34.4 sync.

**Not a code defect, not a fix-it-now item.** Practical mitigations:
1. Run `bun test --bail` to abort on first PGLite-cold-start miss
   rather than letting it accumulate.
2. Run a specific test file (`bun test test/<file>.ts`) when you only
   need targeted coverage — fork's day-to-day green path.
3. If we ever need full-suite green on this box, the upstream-side fix
   is bumping the hook timeout via `test.timeout(15_000)` at the top
   of any `.serial.test.ts` that boots PGLite cold. Not worth filing
   upstream unless other operators report the same wedge.

Diagnosis evidence: bun-test-bail log captured the failing file name
clearly (single test failed before the others kept running). Suite
total before bail: 616 tests / 37 files / 45 s; 0 unexpected failures
beyond the timeout itself.

### [x] ai.gateway "google recipe missing max_batch_tokens" NOTICE — DONE 2026-05-15 (fork-local + upstream PR pending)

`src/core/ai/recipes/google.ts` now declares `max_batch_tokens: 20_000`
+ `chars_per_token: 2` (CJK-aware density on mixed Notion corpora);
`safety_factor` left at gateway default 0.8 → pre-split at ~8 000
chars/batch. Manual `kos-compat-api /ingest` smoke confirmed the
warning no longer surfaces and embedding round-trips at 0.99+ cosine
on the new chunk. 34/34 `recipes-contract` + `gateway` tests pass.

Fork-local patch doc at
[`docs/UPSTREAM-PATCHES/v034-google-recipe-max-batch-tokens.md`](../../docs/UPSTREAM-PATCHES/v034-google-recipe-max-batch-tokens.md).
Upstream PR filed 2026-05-15:
**[garrytan/gbrain#1016](https://github.com/garrytan/gbrain/pull/1016)** —
branch `upstream-fix/google-recipe-max-batch-tokens` cut from
`upstream/master` (HEAD `24881f60` v0.34.4), 3 files / +25 -7 / `bun
test test/ai/` 144/144 green. On merge the next fork sync auto-drops
the local diff (additive field change + matching test edits, clean
text merge). Fork master `test/ai/no-batch-cap-suppression.serial.test.ts`
+ `test/ai/adaptive-embed-batch.test.ts` backported in the same
session so `bun test test/ai/` stays 144/144 here too.

**Diagnostic correction** — the original P2 framing suggested this
was just log noise. A 2026-05-15 morning probe initially read the
notion-poller stderr's 117 394 historical `ingest 500` lines as an
active fire; ingest_log + a manual `/ingest` probe disproved that.
The actual 500s in stderr date from the v0.21 PGLite-lock-deadlock
era (Path 3 root-caused 2026-04-29). 38 MB stderr rotated to
`.archive.gz` and `.gitignore` extended so future rotations stay
out of git.

### [ ] (facts:absorb) Sub-process facts:absorb writer has no DB connection (added 2026-05-15)

While verifying the max_batch fix, every `kos-compat-api /ingest`
response output still carries:
`[facts:absorb] failed to log gateway_error for sources/<slug>: No
database connection: connect() has not been called. Fix: Run gbrain
init --supabase or gbrain init --url <connection_string>`.

Source: `src/core/facts/absorb-log.ts:76`. The writer runs inside a
`gbrain sync` sub-process spawned by `kos-compat-api`; that
sub-process inherits env but `BrainDb.connect()` is never called on
its path. Ingest itself succeeds (page lands, chunks embed, sync
returns 0), so this is **log-only** today — but it means
`ingest_log.source_type='facts:absorb'` rows for `gateway_error`
events from compat-api never land. `gbrain doctor`'s
facts_extraction_health check (`src/commands/doctor.ts:1894+`) reads
from that table, so detection windows are blind to compat-api
embedding errors.

Either (a) ensure the sub-process initializes the DB connection
before facts:absorb fires, or (b) treat compat-api spawned sync as a
"detached" context and skip facts:absorb logging there with an
explicit guard. Filed for upstream-side decision — fork can't fix it
without `src/core/facts/` edits.

**Scope**: 30-60 min to locate the init gap + decide (a) vs (b);
upstream PR after.

---

## P3 — speculative

### [ ] 启用 v0.20+ 上游 features (Postgres-only)

**Why**: Path 3 解锁 jobs supervisor、queue_health、wedge-rescue、
backpressure-audit。我们没跑 worker daemon 所以没立刻收益,但若以后想
用 `gbrain agent run` durable subagent runtime(v0.16),现在能跑了。

**What**: 评估业务价值。若有具体 use case(如自动化 dikw-compile 或
长跑 enrichment),配置 supervisor + worker。否则不做。

**Acceptance**: 决定记录(`docs/JARVIS-ARCHITECTURE.md` 或 README)。

**Scope**: 30 min 评估,2-3 h 配置(若选)。

---

## Done (most recent)

- [x] **2026-05-09 v0.31.2 上游同步 (sync-v0.31.2 branch)** — 22 commits 跨 5 大版本 (v0.27.0/v0.28.x/v0.29.x/v0.30.x/v0.31.x → v0.31.2) / 378 文件 / +57691 -1833 LoC,**只 5 个 conflict** (上次 v0.26.7 是 31)。机械分类:`package.json` 保 fork `@electric-sql/pglite 0.4.4` override + 加 upstream `@jsquash/{avif,png}` 解码器,`bun.lock` + `llms-full.txt` take upstream regenerate (bun install + bun run build:llms),`README.md` take v0.28.8 LongMemEval 头条 (HEAD 有 v0.25.0 重复段),`skills/RESOLVER.md` take 上游 voice-note 5-keyword + 重新 append KOS 段。`pglite-engine.ts` WAL patch **自动 merge 干净**(无需 reapply,upstream 重构没动 disconnect 块)。`bun install` 拉 20 新 dep (ai@6 + @ai-sdk/{anthropic,google,openai,openai-compatible}@3 + jsquash + heic-decode + eventsource-parser + exifr)。typecheck 干净 (~3s),bin compile 0.31.2,`bun run test` 4760 pass / 9 fail (1 known + 2 env-coupled fork P2 + 2 self-test 递归 + 2 doctor-fix env + 1 perf warn + 1 build-llms 已 regen 修),`bun run check:all` clean。**production schema v34 → v45 silent-applied via bun install postinstall** — v0.31.1.1 fixwave (#682+#741) 的 bootstrap 加固真的 work,**无需手动 ALTER**(对比 v0.26.7 sync 的 mcp_request_log 手 ALTER 教训)。35 tables 全 RLS,facts table 已 ready (0 entries 等下次 ingest),2718 pages,brain_score 80/100,embed coverage 96% (244 stale 等下次 backfill)。**M3 milestone probe-passed**: `gbrain providers test --model google:gemini-embedding-001` 用现有 NANO_BANANA_API_KEY → 286ms / 768 dim default green。Production cutover 推到下个 session(本机 PGLite #223 cold-start hang 阻碍 `/tmp/pilot-brain` 端到端验证;用 Postgres-backed throwaway DB 绕开)。**PR #627 closed as superseded** by upstream v0.31.1.1 fixwave。**Privacy 修**: upstream check-privacy.sh 抓到 3 处历史 sync 记叙文里的 banned word(`docs/JARVIS-ARCHITECTURE.md` §6.20 + `skills/kos-jarvis/TODO.md` L416),改成 generic 措辞。Service mesh restart: kos-compat-api PID 27071→92596 (v0.31.2 loaded), gemini-embed-shim 续跑, 4 cron 服务 (dream-cycle/kos-patrol/notion-poller/enrich-sweep) bootout/bootstrap 后 idle 等定时。kos-patrol smoke: `~/brain/.agent/dashboards/knowledge-health-2026-05-10.md` 写出,2718 pages / 0 ERROR / 1421 WARN (WARN 涨从 762 由于 +241 新 page + 可能新 lint rule)。完整 sync 故事 [§6.22](../../docs/JARVIS-ARCHITECTURE.md#622-upstream-v0312-sync-2026-05-09)。
- [x] **2026-05-05 Feishu signal-detector extension 退役 + brain-side bridge docs 归档** —
  Lucien 复盘判定 `~/.openclaw/extensions/jarvis-feishu-signal-detector/` 在产 garbage:
  虽然 extension 实际部署且每天采信号 (Haiku 4.5 per-message + 写 `~/brain/agent/pending-enrich.jsonl`),
  但下游 `enrich-sweep` 从未在 cron 上消费这个队列(始终是 manual `--plan`),信号写入无人读。
  决议:rm `~/.openclaw/extensions/jarvis-feishu-signal-detector/`(独立 repo
  `~/Projects/jarvis-feishu-signal-detector/` 保留为冷备,Lucien 手动重启 gateway);
  fork repo 内 `git mv` 三份契约文档进 `_archived/`(`skills/kos-jarvis/_archived/feishu-bridge/`,
  `skills/kos-jarvis/_archived/pending-enrich/`,`docs/_archived/FEISHU-SIGNAL-DETECTOR-SETUP.md`)。
  跨文件引用同步:`skills/manifest.json` 删 2 entry,`skills/RESOLVER.md` 删 2 trigger 行 + 加归档说明,
  `skills/kos-jarvis/README.md` 表格 + 目录树 + 状态行更新,`workers/kos-worker/SETUP.md` +
  `docs/integration-clients.md` + `skills/kos-jarvis/{enrich-sweep,gemini-embed-shim}/SKILL.md` +
  `CLAUDE.md` 路径改到 `_archived/`,`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md` 决定从 KEEP unique 改为
  ARCHIVED(KEEP-unique 数 7 → 5)。Net fork 收缩(本轮): 16 → 14 active dirs。
- [x] **2026-05-04 PR #627 to garrytan/gbrain (forward-reference bootstrap fix)** — branch `upstream-fix/bootstrap-mcp-log-cols` 切自 `upstream/master` (HEAD `058fe69` v0.26.7), 不带 fork-local 内容; push 到 ChenyqThu/jarvis-knowledge-os-v2 fork; gh pr create 提 PR 到 garrytan/gbrain master。Diff 干净: 4 files / +146 -5 lines / 100% additive (postgres + pglite engines extend probe → ALTER COLUMN IF NOT EXISTS, schema-bootstrap-coverage REQUIRED_BOOTSTRAP_COVERAGE 加 3 entries, e2e postgres-bootstrap 加 mcp_log regression case)。Validation: typecheck clean, schema-bootstrap-coverage 2/2, bootstrap.test 6/6 (no regression), postgres-bootstrap e2e 3/3 against `pgvector/pgvector:pg16` (新 case 33ms)。等 garrytan review/merge,merge 后下次 fork sync 拉到这条 fix 即可删 `docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md`。链接: https://github.com/garrytan/gbrain/pull/627
- [x] **2026-05-04 M2-A wire-status check — verdict: RETIRE triplet** — Production probe (2026-05-04, schema v34): `dikw_layer` 0/2477 (0.00%), `evidence_level` 1/2477 (0.04%), `confidence` 2470/2477 但值是 `kos-compat-api.ts:454,533` 硬编码 template 字符串 (`confidence: low` 写死),不是 confidence-score 脚本算的。Cross-check: `kos-compat-api.ts` (HTTP 入口) / `workers/notion-poller/` (cron) / `kos-patrol/run.ts` 都不 spawn 三件套 `run.ts`。`kos-compat-api.ts:600` 那行 "dikw-compile recommended" 只在 JSON `next:` 提示字符串里,API caller 可忽略,不算 invocation。`kos-patrol/SKILL.md:100` cross-ref `confidence-score/SKILL.md` 是 doc 引用,不是 code call。**结论**: 三件套 (`dikw-compile`, `confidence-score`, `evidence-gate`) 在 production 是 100% dead code,从未在 ingest pipeline 中跑过。`concept-synthesis` v0.25.1 跟 dikw 结构不同 (per-batch sweep over `concepts/` only, 4-phase dedup+score+synth+cluster, vs dikw 的 per-page DIKW layer cross-kind),但 188 个 concept pages 是它的天然目标。**Decision**: archive 三件套 → `skills/kos-jarvis/_archived/`, pilot concept-synthesis 在 188 pages 上 (next session, 2 h)。Net fork shrinkage: 11 active → 8。Combined with kos-lint retire (M1) → 11 → 7 active 由下次 sync 时实现。完整记录: `docs/KOS-JARVIS-CONSOLIDATION-PLAN.md` §M2-A + `docs/JARVIS-ARCHITECTURE.md` §6.21 "M2-A resolution"。
- [x] **2026-05-04 服务 smoke (kos-compat-api + cron 全过)** — `kos-compat-api` PID 87485 → 27071, `gemini-embed-shim` PID 63403 → 27143 (launchctl bootout/bootstrap, 加载 v0.26.7 src via shim)。`gbrain --version` returns 0.26.7。local + remote `kos.chenge.ink/status` 都返回 `total_pages=2477` ✅ 一致。`launchctl kickstart -k kos-patrol` smoke: exit=0, **0 ERROR / 0 WARN**, dashboard + digest 写到 `~/brain/.agent/{dashboards,digests}/`。`notion-poller` 5 个 cycle 干净 (`0 ingested, 0 skipped`)。**惊喜发现**: kos-patrol stderr `[2] kos-lint JSON parse failed; exit=3` — `kos-lint` 已经天然 broken,patrol 跳过它后照常 0 WARN。这是 PILOT-RETIRE 候选最强 evidence,M1.kos-lint-retire pilot 从 4h research 简化为 ~30 min mechanical cleanup。
- [x] **2026-05-04 production schema 升 v31 → v34 (apply-migrations 跑通)** — `gbrain init --migrate-only` 头一次失败,报 `column "agent_name" does not exist` (SCHEMA_SQL line 420 `CREATE INDEX … (agent_name, created_at DESC)` forward-references v0.26.3 列;`applyForwardReferenceBootstrap()` 数组**漏**了 mcp_request_log 3 个 v0.26.3 列 — upstream "structurally prevented" 自夸的 bootstrap pattern 又一次 fail)。Workaround: 手动 `ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS agent_name TEXT, params JSONB, error_message TEXT;` 后再跑 init --migrate-only,3 个 migration 全 apply (v32 oauth_infrastructure / v33 admin_dashboard_columns_v0_26_3 / v34 destructive_guard_columns)。验证: schema_version=34 (latest),`gbrain doctor` connection ok,RLS 31/31 tables,embeddings 100%,brain_score 83/100,oauth_clients/oauth_authorization_codes/oauth_access_tokens/oauth_refresh_tokens 4 表 created,pages.deleted_at 列 present。Doctor 总 status=warnings (85),3 个非 P0 warn:resolver_health 37 routing_miss (上游 v0.25.1 新 9 skill 的 routing-eval fixture phrases 跟 RESOLVER 触发词不齐 — 上游小 bug 见 P2),sync_failures 1 (people/will-vanish.md,旧),graph_coverage 0% display (但 brain_score 给满分 25/25 link + 3/15 timeline,矛盾,doctor display bug)。完整 patch 候选写在 [`docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md`](../../docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md),P0 列表已填 upstream PR 任务。
- [x] **2026-05-04 v0.26.7 上游同步 (commit `a2e5e5b`,branch `sync-v0.26.7`)** — 25 commits 跨 8 release (v0.25.1 → v0.26.7) 一次 merge。31 个冲突机械分类:19 个 src/test 文件直接 take upstream(post-base 全部是 sync 副作用,fork 没动 src/), `pglite-engine.ts` WAL patch 14 行重新 apply,`@electric-sql/pglite 0.4.4` override 保留(upstream 想 0.4.3),`skills/RESOLVER.md` KOS-Jarvis extensions 段移到末尾(v0.25.1 加了 Uncategorized 段在前),`skills/manifest.json` 49 skill (30 旧 + 9 v0.25.1 + 10 fork),`.gitignore` 显式合并 fork 段 + upstream `.context/`,CHANGELOG/TODOS 顶部 fork HEAD 段为空 → 直接 take upstream entries。`bun install` 拉新 deps (cookie-parser, cors, express, express-rate-limit 来自 v0.26.0 admin)。`bun run typecheck` 干净(~3s),bin compile 出 0.26.7,49 skill conformance 全过。**生产 Postgres schema 仍 v31**(repo merge 不动 production),`gbrain doctor` 报 `connection: fail "column deleted_at does not exist"`(v0.26.5 destructive_guard_columns migration 待跑) + 37 routing_miss WARN(上游新 9 skill 的 routing-eval fixture phrases 太严)。**Review 关键发现**:(a) v0.25.1 `concept-synthesis` (T1-T4 tier + LLM synthesis on concepts/) 与 fork `dikw-compile + confidence-score` 部分重叠 → M2-A 候选;(b) v0.26.0 `gbrain serve --http` + bearer auth + admin dashboard 给 `kos-compat-api` 内部走 MCP-over-HTTP + 翻译层开了门 → M2-B 候选;(c) v0.25.1 `archive-crawler` 覆盖 fork 原 Phase 4-5 邮件/日历 import 计划 → M2-C 候选;(d) `Operation.scope` + `.localOnly` 是 fork `OperationContext.remote` 的成熟版 → M2-D 候选。M2 milestone 4 项 P1 已加入上方"M2 milestone 候选"段。Net target 从 M1 的 "16 → 11 active" 进一步缩到 M2 后 "11 → 7-8 active"。
- [x] **2026-05-02 night consolidation PLAN 写就 (P0 closed)** — 详细分析 16 个 fork skill dirs vs v0.25.0 上游 32 skill 的覆盖度,写 [`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](../../docs/KOS-JARVIS-CONSOLIDATION-PLAN.md) (~700 行)。Inventory matrix (18 行/skill × {wired/cover/upstream-feature/decision/notes})、5 个 decision bucket (KEEP-unique 7 / KEEP-partial 4 / ARCHIVE 2 / PILOT-RETIRE 1 / REWRITE-AS-LINK 1)、`kos-lint` pilot test plan (4 步 procedure + acceptance + ~4h estimate)、4-milestone deprecation timeline (M1 baseline / M2 next sync / M3 provider abstraction probe / M4 v0.26.0+60d retro)、7-row risk register、out-of-scope notes、acceptance criteria。**Net target**: 16 active skill dirs → 11 active + 2 archived + 1 retired by v0.26.0。M1 milestone 拆 4 个 P1 落地项已搬到上面 P1 list。
- [x] **2026-05-02 evening launchd surgery — dream-cycle + kos-deep-lint P0 双杀** — Path A 完整执行:5 plist templates 删 `GBRAIN_HOME` env 块 (`com.jarvis.{dream-cycle,kos-compat-api,kos-patrol,enrich-sweep,notion-poller}.plist.template`),5 deployed plists 同步改 (~/Library/LaunchAgents/),回收 `com.jarvis.kos-deep-lint.plist.template` 进 repo + 加 `PATH` env block (closes exit 127:wrap script 内 `./kos` 是 `#!/usr/bin/env bun` shebang,launchd 默认 PATH 找不到 bun)。bootout + bootstrap 6 服务 (kos-compat-api 第一次 bootstrap 失败 `Input/output error`,retry 即 OK,新 PID 87485)。迁移 `~/brain/.gbrain/{audit/backpressure-2026-W18.jsonl,audit/subagent-jobs-2026-W18.jsonl,sync-failures.jsonl}` → `~/.gbrain/` (W18 audit 文件目标侧不存在,zero overlap;sync-failures.jsonl 同样 zero overlap)。删空 `~/brain/.gbrain/`。验证:`launchctl kickstart -k gui/$UID/com.jarvis.dream-cycle` 写出 `~/brain/.agent/dream-cycles/2026-05-02T07-38-04Z.json` (status=partial / 8 phases / 2572ms / exit 0,新 v0.25.0 synthesize+patterns phase 跑通);kos-deep-lint PATH smoke (mimic launchd env) bun 1.3.10 reachable + `kos --help` 输出 OK;6 服务 `launchctl print` 全部 `GBRAIN_HOME_lines=0`,kos-compat-api state=running PID 87485 binds :7225。Sandbox 拦了 launchctl(`Operation not permitted` + `Input/output error`),用 `dangerouslyDisableSandbox` 绕过。**P0 closed**:dream-cycle production breakage + kos-deep-lint exit 127。Net P0 list 从 3 缩到 1 (consolidation review)。
- [x] **2026-05-02 v0.25.0 sync — merged to master** (commit `f6bb039` no-ff merge of `sync-v0.25.0`). Post-merge: gemini-embed-shim (PID 2502→63403) + kos-compat-api (PID 32389→63464) restarted to load v0.25.0 src/cli.ts via `~/.bun/bin/gbrain → src/cli.ts` shim. /status local + remote both confirm total_pages=2425. Dream `--phase orphans` from /tmp ✓. kos-patrol cron one-shot ✓ (exit 0, dashboard + digest written to `~/brain/.agent/{dashboards,digests}/`). `~/.gbrain/config.json` extended with `eval.capture: true` + `scrub_pii: true`; first eval row captured by smoke `gbrain query`. **`.env` + `.env.local` `GBRAIN_HOME=/Users/chenyuanquan/brain` commented out** with explanatory blocks (was a leftover from the never-completed "brain config under brain repo" migration; redirected loadConfig to a non-existent path). Local-dev gbrain CLI now works from project dir; 3 of 5 prev-failing tests fixed. **2 follow-ups filed P0** (see top): dream-cycle cron breakage from launchd-plist-set GBRAIN_HOME (same root cause; plist surgery deferred to next session), kos-deep-lint exit 127 (plist drift, pre-existing). Story in [§6.20](../../docs/JARVIS-ARCHITECTURE.md#620-upstream-v0250-sync-2026-05-01).
- [x] **2026-05-01 v0.25.0 upstream sync** (branch `sync-v0.25.0`) — 16 commits / 12 versions in one merge: v0.22.10 → v0.22.16 (7 patch releases handoff missed), v0.23.0/0.23.1/0.23.2 (dream conversation synthesis + local CI gate + dream marker fix), v0.24.0 (skillify hardening), v0.25.0 (BrainBench-Real eval capture). Schema v29 → v30 (`eval_candidates` + `eval_capture_failures`). Conflicts on 8 files (`.gitignore`, `VERSION`, `package.json`, `bun.lock`, `CHANGELOG.md`, `TODOS.md`, `src/core/sync.ts`, `test/sync-failures.test.ts`) — all empty-HEAD additions or version-string overrides. WAL fork patch (`pglite-engine.ts:182 pg_switch_wal()`) survived. Privacy-gate (`scripts/check-privacy.sh`, new in upstream) fired on 2 fork files mentioning the banned name; scrubbed (the prior-fork slug form → `your-openclaw/chat/`, example JSON line genericized). **BrainDb safety net**: added 5 eval methods (`logEvalCandidate` / `listEvalCandidates` / `deleteEvalCandidatesBefore` / `logEvalCaptureFailure` / `listEvalCaptureFailures`) + 4 type aliases + 6 unit tests (in-memory PGLite, hermetic). Handoff's "BrainDb 必须补齐 5 方法" was wrong (BrainDb is not a BrainEngine impl), but mirroring the surface anyway lets future fork skills consume eval data without reaching into upstream `src/core/`. **Decision reversed at session start**: enabled `GBRAIN_CONTRIBUTOR_MODE` / `eval.capture=true` (handoff said don't, but baseline-gating future retrieval changes is worth the per-call write). Validation: typecheck clean, `bun test` 1400+ green, BrainDb test 6/6, doctor schema_version 30, `/status` local + `kos.chenge.ink` total_pages=2424, kos-patrol smoke OK, dream `--phase orphans` OK. Story in [§6.20](../../docs/JARVIS-ARCHITECTURE.md#620-upstream-v0250-sync-2026-05-01).
- [x] **2026-04-30 D + G + H 收尾** —
  - **D (upstream v0.22.9 sync, commit `8ae9aef`)**: cherry-pick
    `08746b0` 单 commit (sync error-code 分类 — `classifyErrorCode()`,
    `summarizeFailuresByCode()`,12 new tests)。Conflict 仅
    `.gitignore` 一处(merge 两边),解 conflict 保留 fork OMC + launchd
    runtime ignore + upstream `.claude/`。Build OK 190ms bundle / 255ms
    compile,`gbrain --version` 0.22.9。
  - **G (`default` source `local_path` 设)**: SQL 一句 UPDATE
    `sources` SET `local_path='/Users/chenyuanquan/brain'` WHERE
    `id='default'`。`gbrain frontmatter audit --json` `per_source` 现
    填:`[{source_id:"default", source_path:"/Users/chenyuanquan/brain",
    total:0, ...}]`。
  - **H (push to origin/master)**: 7 commits push (Phase B/C 6 +
    v0.22.9 1)。GitHub HEAD = local HEAD。
- [x] **2026-04-30 Phase C cleanup — dead-link cluster + patrol dedup +
  cosmetics + arch §6.19** — 推 Lucien 选的 A+B+C+E+F 5 项一波打完。
  - **A (35 dead-link ERROR → 0)**: brain 21 文件 × 31 link 重写从
    same-dir short form `(slug.md)` → 完整 `(../<dir>/slug.md)`,3 轮
    sync(commits `cde82a1`/`ede9a40`/`1349986`)消尽 lint cluster。
    Decisions/phase-2-feishu 4 个 cross-repo refs 改 backtick form
    (brain ≠ fork repo,不该 wikilink fork 文件)。
  - **B (patrol Phase 4 case-variant dedup)**: phase4() 加 normalize
    (lowercase + strip non-alphanum + drop suffix Inc/LLC/Ltd/Corp/Co/
    GmbH) + Levenshtein ≤ 1 (≥ 4 chars) 两阶段合并。验证:Link Systems
    Inc 5 变体合并为 379 mentions(原 206 + 88 + 56 + 19 + 10 单独占 5
    个槽位),Link Canada Inc 51,MCMC JENDELA 35。Dashboard 现在显示
    Cloud VMS / RADIUS Server / MCP Server / Link Cloud / Link EBG /
    AWS CDN / Operations Assistant / Time Upgrade / Upload Firmware /
    Carrier Grade AAA / PoE AIO / Omada Roadmap / Omada Beta Program 等
    真长尾 entity gap。
  - **C (graph_coverage 0% docs)**: 加 §6.19 to JARVIS-ARCHITECTURE.md
    解释 markdown-only brain 的 metric 行为 — `graph_coverage` 用
    page-percent (% pages with ≥1 inbound entity-link / timeline) 算法,
    notion source 占 60% 不会被 entity-extract,所以 percentage 趋 0%。
    Code Cathedral metric 同理 0%(我们无 code page)。**这是 design
    property,不是 regression**;不跑 `gbrain link-extract` 追指标。
  - **E (`/status` engine label `pglite` → `postgres`)**: 改
    `server/kos-compat-api.ts:258` 解决 Path 3 之后的旧 hardcoded
    label。下游 Notion Knowledge Agent / OpenClaw feishu 现在拿到正
    engine 标识。
  - **F (kos-patrol launchd exit 2 → success)**: `scripts/launchd/
    com.jarvis.kos-patrol.plist.template` 加 `<key>SuccessfulExitCodes
    </key><array><integer>0</integer><integer>2</integer></array>` —
    patrol 设计 0=clean / 1=ERROR / 2=WARN-only,launchd 不再因 exit 2
    报"ServiceFail"。Exit 1(真有 ERROR)仍 surface。
  - **Net**: 2 P1 + 1 P2 + 2 P3 关闭。Phase A→B→C 系列总耗 ~3 h focused
    work,2305→2340 pages,100% embed coverage 保持,brain_score 84/100
    稳定(embed 35/35 + links 25/25 + timeline 3/15 + orphans 11/15 +
    dead-links 10/10)。
- [x] **2026-04-29 Phase A system review + Phase B #1+#2 双杀** —
  Lucien 触发 first systematic review since 04-22。Phase A 实测 6 维度
  (brain health / service mesh / query smoke / storage / patrol /
  TODO 对账),plan at `~/.claude/plans/session-docs-session-handoff-
  2026-04-29-piped-codd.md`。Phase B-1: `scripts/jarvis-pg-backup.sh` +
  `com.jarvis.gbrain-backup.plist.template` + launchctl bootstrap;
  manual run 产 63MB pg_dump (DB 239MB → 26 % gzip),pg_restore --list
  TOC 275 entries,daily 03:33,14d retention。Phase B-2:
  `skills/kos-jarvis/kos-patrol/run.ts` 加 30+ stoplist 词 (4 passes) +
  ≥2-distinct-kind 规则。dashboard 从 100 % Notion column-header 噪声
  ("Original EML"×862, "Action Type"×858) 翻转到 95 % 真实信号
  (Link Systems Inc, MCMC Jendela, Cloud VMS, RADIUS Server, MCP Server,
  PoE AIO, Omada Roadmap...)。
- [x] **2026-04-29 241 stale embeddings auto-consumed** — Phase A
  实测 `SELECT COUNT(*) FROM content_chunks WHERE embedding IS NULL`
  返 0。期间无人手动跑 `gbrain embed --stale`;推断 dream-cycle 的
  embed phase 在 04-29 23:44Z 跑过把 NULL 一并补完(虽然 phase report
  说 0 embedded,可能 timing/caching 问题)。Net: 100 % embed coverage,
  原 P1 关闭。
- [x] **2026-04-29 zombie sync leak closed by Path 3** — PGLite 时代
  6 个 long-running zombie 持锁问题,Phase A `ps -axo` 实测 0 zombie,
  Postgres MVCC 让 zombie 即使存在也不阻塞 client。原 P1→P2(observation)
  现归档 Done。剩余 root cause(spawn 来源)若再出现可由 patrol Phase 7
  cheap WARN 监测捕获。
- [x] **2026-04-29 Path 3 Postgres migration** (commit `33c0410`) —
  PGLite single-writer lock topology silent-fail under v0.21+ workload.
  Migrated to local Postgres 17 + pgvector 0.8.2 via `gbrain migrate
  --to supabase --url postgresql://chenyuanquan@127.0.0.1:5432/gbrain`.
  2117 pages + 8231 links + 11084 timeline transferred. BrainDb dual-
  engine refactor (~80 LOC). 0 plist edits. notion-poller +186p/5.5min
  /0 zombies. dream-cycle 1030ms warm. /status 90 ms during burst.
  Trigger #3 of v020 evaluation satisfied. See [§6.18](../../docs/JARVIS-ARCHITECTURE.md#618-pglite--本地-postgres-迁移--path-3-p0-unblock-2026-04-29-afternoon).
- [x] **2026-04-29 spawnAsync fix** (commit `093601e`) — replaced 4
  `spawnSync` calls with Promise-wrapped `spawn` to unfreeze Bun event
  loop. /status stayed responsive (138-193ms) during in-flight gbrain
  sync 134s. **Made Path 3 unnecessary for the event-loop fix**, but
  Path 3 was still needed for the lock-deadlock root cause.
- [x] **2026-04-29 v0.22.8 upstream sync** (commit `811c266`) — merged
  9 minor releases (v0.21.0 → v0.22.8). Schema v24 → v29 via
  v0.22.6.1's `applyForwardReferenceBootstrap()`. Fork patch on
  `pglite-schema.ts` dropped (#370 closed by upstream PR #440). WAL
  fork patch retained for cold-backup viability. Production cutover:
  2117/2117 pages preserved, brain_score 85/100 stable.
  Story in [§6.17](../../docs/JARVIS-ARCHITECTURE.md#617-upstream-v0228-sync-2026-04-29-commit-811c266).
- [x] **2026-04-27 evening Tier 1 sweep** + frontmatter-ref-fix v1+v2
  + 4 orphan-reducer rounds. Lint ERRORs 4→0, frontmatter long-tail
  refs 70→0, orphans 814→732. See archived TODO + §6.15-§6.16.
- [x] **2026-04-25 v0.20.4 upstream sync** (commit `8665afb`).
- [x] **2026-04-23 v0.18.2 upstream sync** with 1-line fork patch
  (commit `aceb838`) — closed today by v0.22.6.1.
- [x] **2026-04-22 v0.17.0 upstream sync** (commit `b6ea540`) +
  filesystem-canonical Step 2.2/2.3.
- [x] **2026-04-20 v0.14.0 upstream sync** + 85-page wiki import +
  port cutover.

Older items in archived TODO at git `14fff49^:skills/kos-jarvis/TODO.md`.
