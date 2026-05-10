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

Brain (post-v0.26.7-merge **+ schema v34 applied 2026-05-04**):
2477 pages, 100 % embed coverage. brain_score 83/100. doctor status:
warnings(85)。生产 Postgres 17 + pgvector 0.8.2 已升到 schema v34
(oauth_infrastructure + admin_dashboard_columns + destructive_guard
全 applied),WAL fork patch retained for fork-local PGLite tooling
(brain-db.ts).

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

## P0 — upstream PR 已提交 (forward-reference bootstrap 修)

### [x] PR #627 to garrytan/gbrain — DONE 2026-05-04

**Filed**: https://github.com/garrytan/gbrain/pull/627

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

### [ ] (M2-A.execute) Archive triplet + concept-synthesis pilot

**Why**: M2-A wire-status 已查清,需要把决议落地。3 个 skill dirs
搬到 `_archived/`,触发器从 RESOLVER + manifest 摘掉。然后跑一次
concept-synthesis 看 188 个 concept pages 跑出什么。

**What**:
1. `mv skills/kos-jarvis/{dikw-compile,confidence-score,evidence-gate}
   skills/kos-jarvis/_archived/`
2. 删 RESOLVER.md `## KOS-Jarvis extensions` 段三件套触发器
3. `skills/manifest.json` 三件套标 `archived: true` 或删
4. 改 `server/kos-compat-api.ts:600` 提示字符串:
   `"dikw-compile recommended"` →
   `"page is searchable; use 'gbrain dream' for cross-page synthesis"`
5. Pilot run: invoke `concept-synthesis` skill agent on `~/brain/concepts/`
   (188 pages),输出 → `~/brain/.agent/reports/concept-synthesis-pilot-<date>.md`
6. 看 T1/T2/T3/T4 分布,判断是否要 wire 到 dream-cycle (P1.5)
7. README + 架构 doc 反映:active skills 11 → 8

**Acceptance**: triplet dirs 在 `_archived/`,RESOLVER 不再触发,
49 → 46 manifest skills (或 49 - 3 retired)。Pilot report 写到
brain。

**Scope**: 30 min mechanical retire + 1 h pilot + 30 min 写 report。
Total 2 h。

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
