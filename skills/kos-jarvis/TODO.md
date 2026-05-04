# kos-jarvis — Outstanding Work (post v0.26.7 sync, 2026-05-04)

> **Updated**: 2026-05-04 — **v0.26.7 上游同步完成** (commit `a2e5e5b`),
> 25 commits 跨 8 release (v0.25.1 → v0.26.7) 一波合并。31 个冲突全部
> 解决:19 个 src/test 直接 take upstream(只有 sync 副作用,fork
> 没真改),`pglite-engine.ts` WAL patch 重新 apply,`@electric-sql/pglite
> 0.4.4` override 保留,`skills/RESOLVER.md` KOS-Jarvis extensions 段
> 移到文件末尾(v0.25.1 加了 Uncategorized 段在前)。typecheck 干净,
> bin 编译 0.26.7,49 skill conformance 全过。
>
> **新发现的 P0 (production)**: `gbrain doctor --json` 报 `connection:
> fail "column deleted_at does not exist"` — v0.26.5 的
> `destructive_guard_columns` migration 还没在生产 Postgres 跑。本 fork
> repo 不动 production schema,要单独 `gbrain apply-migrations --yes`。
>
> **新发现 (重要 review 结论)**: 上游 v0.25.1 的 `concept-synthesis`
> (T1-T4 tier + LLM synthesis on `concepts/`) 与 fork `dikw-compile +
> confidence-score` 部分重叠 — 都是分层 + LLM 强链接。**M2 评估候选**。
> v0.26.0 的 `gbrain serve --http` + bearer auth 也开启了 `kos-compat-api`
> 内部走 MCP-over-HTTP + 翻译层的可能 — **M2 评估候选**。
>
> **Pre-v0.25.0 TODO**: archived in git history at `b23ab28`.
> **Pre-system-review TODO**: archived at `2203f94`.
> **Pre-Path-3 TODO**: archived at `7b6a409`.

Brain (post-v0.26.7-merge in repo, **production schema 仍 v31**):
2425 pages, 99.5 % embed coverage. brain_score 83/100. 10 jarvis 服务
全 loaded(`kos-compat-api` PID 87485, `gemini-embed-shim` PID 63403,
6 launchd cron services PID=- waiting for tick)。生产 Postgres 17 +
pgvector 0.8.2,WAL fork patch retained for fork-local PGLite tooling
(brain-db.ts).

---

## P0 — next session (apply-migrations + post-merge soak)

### [ ] 生产 Postgres `gbrain apply-migrations --yes`

**Why**: `gbrain doctor` 当前报 `connection: fail "column deleted_at
does not exist"`。v0.26.5 的 `destructive_guard_columns` migration
(soft-delete + 72h TTL purge for sources + pages) 是上游加的,生产
schema 仍卡在 v31,需要升级才能 unblock 任何 read/write op。

**What**:
1. SSH 到生产 host (本机 `chenyuanquan@chenyuanquandeMac-mini`),
   先 `pg_dump` 备份(`scripts/jarvis-pg-backup.sh` 已 daily 03:33,但
   apply-migrations 前手动 trigger 一次保险),
2. `gbrain apply-migrations --yes` 跑全 v0.26.x migrations:
   - `oauth_infrastructure` (v0.26.0)
   - `admin_dashboard_columns_v0_26_3` (v0.26.3)
   - `destructive_guard_columns` (v0.26.5)
3. `gbrain doctor --json` 验证 `connection: ok`,schema_version 到 v34。
4. 重启 `kos-compat-api` + `gemini-embed-shim` (load v0.26.7 src/cli.ts
   via shim,跟 v0.25.0 sync 时同样 ritual)。
5. /status local + 远程 `kos.chenge.ink/status` 两边都验。

**Acceptance**: `gbrain doctor` `status: ok` + `schema_version >= 34`,
两边 /status 都返回 total_pages=2425+,kos-patrol cron next-tick 跑通。

**Scope**: 30 min (含备份 + 手动验证)。

### [ ] kos-deep-lint 已验过 PATH env block,但 v0.26.7 sync 后再 smoke

**Why**: `kos-compat-api` + `gemini-embed-shim` 重启后,launchd cron 服务
(`kos-patrol`, `dream-cycle`, `notion-poller`, `enrich-sweep`,
`kos-deep-lint`) 没碰过 plist。下一 tick 应正常,但 v0.26.0 的 admin
dashboard build (`admin/dist/` ~6 MB committed) + 新依赖 (express,
cors, cookie-parser) 会让 `bun install` 拉新 deps — 已经在 fork-merge
合并时 `bun install` 跑过(98 packages installed),should be fine。

**What**: 第一次每个 cron 触发后看 stderr log 干净 (no missing module),
patrol exit 0/2 正常,digest 写出。

**Scope**: 5 min spot-check next morning。

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

### [ ] kos-lint 退役 pilot test

**Why**: PLAN §5.4 把 `kos-lint` 列为 PILOT RETIRE。6 个 check 中
4 个 (frontmatter / dead-links / orphans / dup-id) 被上游
`gbrain doctor` + `frontmatter-guard` + `gbrain orphans` 覆盖;
2 个 KOS-unique (weak links / evidence gap) 可抽到一个 ~150 LOC 的
`kos-quality` 小 shim。

**What**: 跑 PLAN §6 写的 4 步 pilot procedure,产出
`~/brain/.agent/reports/kos-lint-pilot-decision.md`,naming retire /
partial / abort + evidence。

**Acceptance**: 决定文件落地;若决定 retire,`kos-quality` 抽出 +
`kos-patrol` Phase 2 改调用 + 老 `kos-lint/` 归档。

**Scope**: 1 h pilot run + 2-3 h 抽 shim (若 retire) + 30 min cron
rewire。Total 4 h。

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

### [ ] (M2-A) `concept-synthesis` ↔ `dikw-compile` + `confidence-score` 对照评估

**Why**: 上游 v0.25.1 加的 `concept-synthesis` (skills/concept-synthesis/SKILL.md)
做的工作与 fork `dikw-compile` + `confidence-score` 部分重叠:
- 都是分层 (上游 T1 Canon / T2 Developing / T3 Speculative / T4 Riff vs
  fork A / B / C / F grade)
- 都是 LLM-driven synthesis on 概念页面
- 都写到 `concepts/`

差异:
- `concept-synthesis` 仅作用于 `concepts/`,且**主目的是 dedup + 整合**
  (多对一收敛)
- `dikw-compile` 是 **cross-kind**(每 kind 各自跑,decision/protocol/
  synthesis 都覆盖),主目的是**强链接质量评级**(每页独立)
- `confidence-score` 是为 dikw-compile 算 score 用的辅助;作用域更窄

**What**:
1. 跑 `concept-synthesis` 一次(dry-run + 或 `--limit 50`)看 T1/T2 输出
   形态。
2. 对比 fork `dikw-compile` 历史输出(若有),看是否 T1+T2 ≈ A+B,T3+T4
   ≈ C+F。
3. 评估能否:
   - (a) `concept-synthesis` 替代 `dikw-compile` 在 concepts/ 上的工作
   - (b) `dikw-compile` 缩到只跑非-concepts kinds
   - (c) `confidence-score` 退役(若 T1-T4 等价于 high/med/low/none 即可)

**Acceptance**: 决定文件 `~/brain/.agent/reports/concept-synthesis-pilot.md`
+ 若决定 partial-retire,`dikw-compile/SKILL.md` 缩 scope + cron 改触发
点 + `confidence-score` 评估退役。

**Scope**: 1 h pilot run + 1-2 h 对比 + 30 min 决策写。Total 3 h。

**Depends on / blocks**: 与 M1 wire-status check 互斥 — 若 wire-status
查出 `dikw-compile` 从未真正在跑,那 M2-A 直接合并到"全退役"决定。

### [ ] (M2-B) `kos-compat-api` ↔ `gbrain serve --http` + thin translator 评估

**Why**: 上游 v0.26.0 加 `gbrain serve --http`(MCP-over-HTTP + bearer
auth + admin React dashboard + Operation.scope/.localOnly)。这是 fork
`kos-compat-api` 当年自建 HTTP boundary 的根本原因第一次 closed。差异:
- 上游契约: MCP JSON-RPC 形态(`tools/call`, `resources/list` 等)
- fork 契约: KOS v1 兼容 (`/query`, `/ingest`, `/digest`, `/status`,
  `/health`,直接 JSON body,适配 Notion Knowledge Agent 和 OpenClaw
  feishu 已有调用)

不能直接退役 `kos-compat-api` (外部系统 hard-coded `kos.chenge.ink/<endpoint>`
契约),但可以:
- (a) 让 `kos-compat-api` 内部 spawn `gbrain serve --http` 子进程,
  然后 KOS-v1 endpoint 翻译成 MCP `tools/call`。Reduce ~500 LOC fork
  code at the cost of 1 子进程跳转。
- (b) 直接迁外部系统到 MCP-over-HTTP(高代价,Notion Agent 不归我们
  控制)。
- (c) 不动 `kos-compat-api`,只观察上游能力,等下次需求(比如多端共享
  brain)再评估。

**What**:
1. 读 `src/commands/serve-http.ts` 看上游 HTTP 形态。
2. 在测试脚本里跑通 `gbrain serve --http --port 7226` + 用 curl 把
   `/query` body 转成 `tools/call` 看是否可行。
3. 评估翻译层 LOC + 风险(认证 / scope / 错误码)。
4. 决定:(a)/(b)/(c)。

**Acceptance**: 决定文件 + 若选 (a),实施任务拆 P1。

**Scope**: 2-3 h 评估,(a) 实施另起 4-6 h。

### [ ] (M2-C) Phase 4-5 邮件/日历导入 → 改基于上游 `archive-crawler`

**Why**: 原 fork plan(`docs/JARVIS-NEXT-STEPS.md`)Phase 4 = 日历导入,
Phase 5 = 邮件导入。**两个都要从头自建 fork-local skill**。但上游
v0.25.1 加的 `archive-crawler`(skills/archive-crawler/SKILL.md)正好
是这个域:Universal archivist for personal file archives(Dropbox /
B2 / Gmail-takeout / local-mount / hard-drive-dump),REFUSES TO RUN
without explicit `gbrain.yml archive-crawler.scan_paths` allow-list。

**What**:
1. 读 `archive-crawler/SKILL.md` 完整看它支持哪些 source format
   (Gmail takeout? iCal export?)。
2. 比对 fork Phase 4-5 原计划(从 Apple Calendar / 邮箱 IMAP 拉数据
   到 brain),看哪些步骤可以直接走 archive-crawler,哪些需要 fork
   pre-processing(如 IMAP → mbox export step)。
3. 决定:
   - (a) Phase 4-5 完全替换为 `archive-crawler` 配置 + minimal fork
     pre-processor
   - (b) 部分迁移(archive-crawler 处理 ingestion,fork 处理 source
     specific extraction)
   - (c) 上游不够用,继续 fork 路线

**Acceptance**: 决定文件 + 若 (a)/(b),`docs/JARVIS-NEXT-STEPS.md`
Phase 4-5 段重写为"上游驱动 + 配置"。

**Scope**: 1.5 h 评估。Phase 4-5 实施本身不在本 milestone 范围。

### [ ] (M2-D) `Operation.scope` + `.localOnly` 取代 fork-local `OperationContext.remote`

**Why**: v0.26.0 把"操作信任分级"做成了 first-class:每个 Op 标
`scope: 'read' | 'write' | 'admin'` + `localOnly?: boolean`,HTTP 路径
强制 reject `admin + localOnly`(`sync_brain`, `file_upload`, `file_list`,
`file_url`)。这是 fork 老 `OperationContext.remote` flag 的上游成熟版。

**What**: 看 fork code base 还有哪里依赖 `ctx.remote`,迁移到 `op.scope`
+ `op.localOnly`。本 fork 不写 src/core/operations.ts,但 `kos-compat-api`
里可能 hand-roll 了 remote check。

**Acceptance**: `git grep "ctx\.remote\|context\.remote"` 在 fork-local
代码 (server/, workers/, skills/kos-jarvis/_lib/) 中归零。

**Scope**: 30 min audit + 30 min 改。

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

- [x] **2026-05-04 v0.26.7 上游同步 (commit `a2e5e5b`,branch `sync-v0.26.7`)** — 25 commits 跨 8 release (v0.25.1 → v0.26.7) 一次 merge。31 个冲突机械分类:19 个 src/test 文件直接 take upstream(post-base 全部是 sync 副作用,fork 没动 src/), `pglite-engine.ts` WAL patch 14 行重新 apply,`@electric-sql/pglite 0.4.4` override 保留(upstream 想 0.4.3),`skills/RESOLVER.md` KOS-Jarvis extensions 段移到末尾(v0.25.1 加了 Uncategorized 段在前),`skills/manifest.json` 49 skill (30 旧 + 9 v0.25.1 + 10 fork),`.gitignore` 显式合并 fork 段 + upstream `.context/`,CHANGELOG/TODOS 顶部 fork HEAD 段为空 → 直接 take upstream entries。`bun install` 拉新 deps (cookie-parser, cors, express, express-rate-limit 来自 v0.26.0 admin)。`bun run typecheck` 干净(~3s),bin compile 出 0.26.7,49 skill conformance 全过。**生产 Postgres schema 仍 v31**(repo merge 不动 production),`gbrain doctor` 报 `connection: fail "column deleted_at does not exist"`(v0.26.5 destructive_guard_columns migration 待跑) + 37 routing_miss WARN(上游新 9 skill 的 routing-eval fixture phrases 太严)。**Review 关键发现**:(a) v0.25.1 `concept-synthesis` (T1-T4 tier + LLM synthesis on concepts/) 与 fork `dikw-compile + confidence-score` 部分重叠 → M2-A 候选;(b) v0.26.0 `gbrain serve --http` + bearer auth + admin dashboard 给 `kos-compat-api` 内部走 MCP-over-HTTP + 翻译层开了门 → M2-B 候选;(c) v0.25.1 `archive-crawler` 覆盖 fork 原 Phase 4-5 邮件/日历 import 计划 → M2-C 候选;(d) `Operation.scope` + `.localOnly` 是 fork `OperationContext.remote` 的成熟版 → M2-D 候选。M2 milestone 4 项 P1 已加入上方"M2 milestone 候选"段。Net target 从 M1 的 "16 → 11 active" 进一步缩到 M2 后 "11 → 7-8 active"。
- [x] **2026-05-02 night consolidation PLAN 写就 (P0 closed)** — 详细分析 16 个 fork skill dirs vs v0.25.0 上游 32 skill 的覆盖度,写 [`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](../../docs/KOS-JARVIS-CONSOLIDATION-PLAN.md) (~700 行)。Inventory matrix (18 行/skill × {wired/cover/upstream-feature/decision/notes})、5 个 decision bucket (KEEP-unique 7 / KEEP-partial 4 / ARCHIVE 2 / PILOT-RETIRE 1 / REWRITE-AS-LINK 1)、`kos-lint` pilot test plan (4 步 procedure + acceptance + ~4h estimate)、4-milestone deprecation timeline (M1 baseline / M2 next sync / M3 provider abstraction probe / M4 v0.26.0+60d retro)、7-row risk register、out-of-scope notes、acceptance criteria。**Net target**: 16 active skill dirs → 11 active + 2 archived + 1 retired by v0.26.0。M1 milestone 拆 4 个 P1 落地项已搬到上面 P1 list。
- [x] **2026-05-02 evening launchd surgery — dream-cycle + kos-deep-lint P0 双杀** — Path A 完整执行:5 plist templates 删 `GBRAIN_HOME` env 块 (`com.jarvis.{dream-cycle,kos-compat-api,kos-patrol,enrich-sweep,notion-poller}.plist.template`),5 deployed plists 同步改 (~/Library/LaunchAgents/),回收 `com.jarvis.kos-deep-lint.plist.template` 进 repo + 加 `PATH` env block (closes exit 127:wrap script 内 `./kos` 是 `#!/usr/bin/env bun` shebang,launchd 默认 PATH 找不到 bun)。bootout + bootstrap 6 服务 (kos-compat-api 第一次 bootstrap 失败 `Input/output error`,retry 即 OK,新 PID 87485)。迁移 `~/brain/.gbrain/{audit/backpressure-2026-W18.jsonl,audit/subagent-jobs-2026-W18.jsonl,sync-failures.jsonl}` → `~/.gbrain/` (W18 audit 文件目标侧不存在,zero overlap;sync-failures.jsonl 同样 zero overlap)。删空 `~/brain/.gbrain/`。验证:`launchctl kickstart -k gui/$UID/com.jarvis.dream-cycle` 写出 `~/brain/.agent/dream-cycles/2026-05-02T07-38-04Z.json` (status=partial / 8 phases / 2572ms / exit 0,新 v0.25.0 synthesize+patterns phase 跑通);kos-deep-lint PATH smoke (mimic launchd env) bun 1.3.10 reachable + `kos --help` 输出 OK;6 服务 `launchctl print` 全部 `GBRAIN_HOME_lines=0`,kos-compat-api state=running PID 87485 binds :7225。Sandbox 拦了 launchctl(`Operation not permitted` + `Input/output error`),用 `dangerouslyDisableSandbox` 绕过。**P0 closed**:dream-cycle production breakage + kos-deep-lint exit 127。Net P0 list 从 3 缩到 1 (consolidation review)。
- [x] **2026-05-02 v0.25.0 sync — merged to master** (commit `f6bb039` no-ff merge of `sync-v0.25.0`). Post-merge: gemini-embed-shim (PID 2502→63403) + kos-compat-api (PID 32389→63464) restarted to load v0.25.0 src/cli.ts via `~/.bun/bin/gbrain → src/cli.ts` shim. /status local + remote both confirm total_pages=2425. Dream `--phase orphans` from /tmp ✓. kos-patrol cron one-shot ✓ (exit 0, dashboard + digest written to `~/brain/.agent/{dashboards,digests}/`). `~/.gbrain/config.json` extended with `eval.capture: true` + `scrub_pii: true`; first eval row captured by smoke `gbrain query`. **`.env` + `.env.local` `GBRAIN_HOME=/Users/chenyuanquan/brain` commented out** with explanatory blocks (was a leftover from the never-completed "brain config under brain repo" migration; redirected loadConfig to a non-existent path). Local-dev gbrain CLI now works from project dir; 3 of 5 prev-failing tests fixed. **2 follow-ups filed P0** (see top): dream-cycle cron breakage from launchd-plist-set GBRAIN_HOME (same root cause; plist surgery deferred to next session), kos-deep-lint exit 127 (plist drift, pre-existing). Story in [§6.20](../../docs/JARVIS-ARCHITECTURE.md#620-upstream-v0250-sync-2026-05-01).
- [x] **2026-05-01 v0.25.0 upstream sync** (branch `sync-v0.25.0`) — 16 commits / 12 versions in one merge: v0.22.10 → v0.22.16 (7 patch releases handoff missed), v0.23.0/0.23.1/0.23.2 (dream conversation synthesis + local CI gate + dream marker fix), v0.24.0 (skillify hardening), v0.25.0 (BrainBench-Real eval capture). Schema v29 → v30 (`eval_candidates` + `eval_capture_failures`). Conflicts on 8 files (`.gitignore`, `VERSION`, `package.json`, `bun.lock`, `CHANGELOG.md`, `TODOS.md`, `src/core/sync.ts`, `test/sync-failures.test.ts`) — all empty-HEAD additions or version-string overrides. WAL fork patch (`pglite-engine.ts:182 pg_switch_wal()`) survived. Privacy-gate (`scripts/check-privacy.sh`, new in upstream) fired on 2 fork files mentioning the banned name; scrubbed (`wintermute/chat/` → `your-openclaw/chat/`, example JSON line genericized). **BrainDb safety net**: added 5 eval methods (`logEvalCandidate` / `listEvalCandidates` / `deleteEvalCandidatesBefore` / `logEvalCaptureFailure` / `listEvalCaptureFailures`) + 4 type aliases + 6 unit tests (in-memory PGLite, hermetic). Handoff's "BrainDb 必须补齐 5 方法" was wrong (BrainDb is not a BrainEngine impl), but mirroring the surface anyway lets future fork skills consume eval data without reaching into upstream `src/core/`. **Decision reversed at session start**: enabled `GBRAIN_CONTRIBUTOR_MODE` / `eval.capture=true` (handoff said don't, but baseline-gating future retrieval changes is worth the per-call write). Validation: typecheck clean, `bun test` 1400+ green, BrainDb test 6/6, doctor schema_version 30, `/status` local + `kos.chenge.ink` total_pages=2424, kos-patrol smoke OK, dream `--phase orphans` OK. Story in [§6.20](../../docs/JARVIS-ARCHITECTURE.md#620-upstream-v0250-sync-2026-05-01).
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
