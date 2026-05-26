# Session handoff — P1-A filesystem-canonical bulk export

> Drafted 2026-04-24 at the close of the P0/P1 wave. Read this first
> when you start the new session. Pair with
> [`docs/plans/P1-A-bulk-export-filesystem-canonical.md`](plans/P1-A-bulk-export-filesystem-canonical.md)
> (the actual plan).

---

## 0 · 中文速读（5 分钟版）

**这是什么**

专门开一个 session 做 **P1-A 大工程** —— 把 PGLite 里只剩 DB、没
落盘的 1857 页 v1-wiki 导入 + 自动 stub，一次性 `gbrain export`
到 `~/brain/`，让文件系统和 DB 1:1 对齐。

**为什么值得单开**

Steps 1→2.3 搞的是**写路径**改造（notion poller 直写盘、dream
cron、slug 正规化、frontmatter 映射、WAL 持久化），那条线做完了。
剩下的是**把 1857 页老数据也搬上盘**。不搬的代价：
- orphan-reducer 95% 的 markdown 双写失败（`skipped_no_file`）
- dream backlinks phase 只能覆盖 110 页
- enrich-sweep / Karpathy grep-wiki 都只对新页起作用
- `~/brain/` git 历史只记录 Step 2.2 之后的知识变化

**为什么是今天的三件事之一**

今天（2026-04-24）刚把 P0/P1 的快胜都做完：WAL 持久化、
notion-poller frontmatter、kos-patrol BrainDb 迁移、orphan-reducer
首轮 real sweep、P0-C 验证、P1-F upstream issue 上交。P1-A
体量 ~2-3h 手工 + 评审时间，不适合塞进当前 session。单开一个
session，用**上面的 plan 按 6-phase 跑**就行。

**当前态（截止 2026-04-24 02:00 附近）**

- Pages 1967 / Chunks 3675（随 notion-poller 波动）
- 盘上 110 .md；DB-only 1857
- Links 695+（orphan-reducer 第二轮还在跑，跑完预期 ~900+）
- Orphans 1705（今晚再做一轮预期 ~1600）
- brain_score 61/100（P1-A 落地后 links/orphans 分量会继续涨）
- 9 个 launchd 服务全健康；dream cron 今晚 03:11 第一次正式过夜
- 主分支 HEAD `fff8351`（v2 repo）；~/brain HEAD `3c92f4b`

**冷启动 3 分钟清单**

1. `cd /Users/chenyuanquan/Projects/jarvis-knowledge-os-v2 && git log --oneline -3`
2. 读 `docs/plans/P1-A-bulk-export-filesystem-canonical.md`（完整
   plan 在那）
3. `gbrain stats && gbrain orphans --count`（记 baseline）
4. 跳到 plan 的 **Phase 0**，按 PASS/FAIL gate 往下走

**今晚不做的事**

- 不动 Step 2.4（commit-batching + remote）—— 这个还在 `+14d defer`
  到 2026-05-07 的政策里。
- 不修 P2 的 kos-patrol gap-detection 噪声（email 模板列头被当
  entity）。
- 不再手动跑 orphan-reducer --apply —— 让它等 P1-A 落地后再跑一
  轮，markdown 命中率会飙升。

---

## 1 · What the prior session shipped (2026-04-24 wave)

| Commit | 干了啥 |
|---|---|
| `ecc6195` | 🏆 **PGLite WAL 持久化 fork-local patch** —— `pg_switch_wal()` before `db.close()`。解锁所有 CLI 写入 |
| `76504eb` | notion-poller frontmatter `title:` + `type:` 补齐，kos-compat-api 生成侧 + 95 existing files 一次性 backfill。lint 190 → 0 warns |
| `444cc81` | kos-patrol phase-1 从 `gbrain list` shell-out 迁到 `BrainDb.listAllPages()`，plist 同步换成 bun 直通。cron 不再 WASM crash |
| `6da8adb` | orphan-reducer 前两轮 `--apply` 战报（20 + 100）。-110 orphans，+285 links，$0.40 |
| `fff8351` | P0-C `/ingest 500` 闭环（被 Path B + WAL 修复隐式解决），P1-F upstream issue 草稿 |
| *(即将提交)* | orphan-reducer 第二轮 weekly sweep + P1-F issue 填了 [#394](https://github.com/garrytan/gbrain/issues/394) |

~/brain 3 commits: notion backfill (95 files), orphan-reducer 工件
+ 探针清理, orphan-reducer 产物（dashboard/digest/reports）。

---

## 2 · Current state

### Git
- v2 repo: `master`, HEAD `fff8351`, clean tree (handoff 文档 untracked)
- `~/brain`: `main`, HEAD `3c92f4b`, clean

### Brain
- Pages 1967 · Chunks 3675 · Embedded 100% · Links 695+ · Tags 189 · Timeline 5443
- Orphans 1705 · brain_score 61/100
- Schema v24，fork patch 1: `v018-pglite-upgrade-fix.md`
- Fork patch 2 (今天加的): `v018-pglite-wal-durability-fix.md`

### Filesystem vs DB
```
disk .md files: 110
DB pages:       1967
gap (DB-only):  1857
```

DB-only breakdown by first-slug segment:
```
sources:      985   (most are /sources/... with various sub-paths)
people:       375
projects:     210
concepts:     181
companies:     85
decisions:      6
syntheses:      4
protocols:      4
entities:       3
comparisons:    3
timelines:      1
```

### launchd
```
-    0   com.jarvis.dream-cycle           (fires 03:11 daily)
-    0   com.jarvis.enrich-sweep
-    0   com.jarvis.kos-deep-lint
-    1   com.jarvis.kos-patrol            (exit=1 is normal: lint ERROR,
                                          not a crash)
-    0   com.jarvis.notion-poller         (5-min cadence, Path B direct)
(PID) 0  com.jarvis.kos-compat-api        (:7220, prod)
(PID) 0  com.jarvis.star-office-ui-backend
(PID) 0  com.jarvis.gemini-embed-shim     (:7222)
(PID) 0  com.jarvis.cloudflared           (kos.chenge.ink tunnel)
```

### Known-good preflight commands

```bash
# 1. Cold context
cd /Users/chenyuanquan/Projects/jarvis-knowledge-os-v2
cat docs/SESSION-HANDOFF-P1A-FILESYSTEM-CANONICAL.md   # this file
cat docs/plans/P1-A-bulk-export-filesystem-canonical.md  # the plan

# 2. Baseline
gbrain stats                     # expect ~1967 pages, may drift ±10
gbrain orphans --count           # expect 1705-ish
gbrain doctor | grep brain_score # expect 61/100-ish

# 3. Confirm overnight dream cycle landed (if starting next morning)
cat ~/brain/.agent/dream-cycles/latest.json | jq '{status, phases:[.phases[]|{phase,status,summary}]}'

# 4. Confirm services
launchctl list | grep jarvis | sort

# 5. Start Phase 0
# (follow plan)
```

---

## 3 · The task — pick up the plan

**Go to**: [`docs/plans/P1-A-bulk-export-filesystem-canonical.md`](plans/P1-A-bulk-export-filesystem-canonical.md)

Six phases with PASS/FAIL gates. Each phase has a rollback. Each
phase can be a pause-point if the session runs short.

**Key landmine**: dry-run export surfaced a `sources/sources/` double-
prefix bug on some DB slugs. **Before Phase 2**, decide how to fix
(plan recommends DB-side slug normalization round 2, mirroring Step
1.5). See plan § 2.1.

**Key success criterion**: after Phase 5 verify, `gbrain sync` reports
no drift and `gbrain dream --dry-run --json` all-phase `"ok"` or
`"warn"` (never `"failed"`).

---

## 4 · Safety tripwires (cumulative, inherited)

(Same as prior handoff — listing here so you don't need to cross-reference)

- **Don't patch `src/*`** unless upstream stalls > 14 days. Two
  fork-local patches already in play (`v018-pglite-upgrade-fix.md`,
  `v018-pglite-wal-durability-fix.md`). Policy in `CLAUDE.md`.
- **Don't touch Step 2.4** before 2026-05-07.
- **Don't change `kos.chenge.ink` request/response shape** without
  updating `skills/kos-jarvis/feishu-bridge/SKILL.md`.
- **Don't downgrade PGLite below 0.4.4**.
- **Don't restart `com.jarvis.notion-poller` while another notion
  ingest is mid-flight.** For P1-A specifically: **boot it out
  entirely for the duration of Phases 0-4**, restore in Phase 5.

---

## 5 · Other live items (NOT on this session's plate)

P0 open:
- [garrytan/gbrain#332](https://github.com/garrytan/gbrain/issues/332) — v0.13.0 orchestrator stuck on partial (cosmetic, upstream)

P1 open (deferred or continuous):
- **Step 2.4** — commit-batching + optional remote (+14d, **don't touch** before 2026-05-07)
- **orphan-reducer weekly sweep** — do after P1-A lands, markdown hit rate will be much better
- **P1-F** — filed as [#394](https://github.com/garrytan/gbrain/issues/394), awaiting upstream
- **pending-enrich queue consumer** — untouched, needs data to accumulate first
- **Phase 2 Feishu signal-detector wiring** — OpenClaw side, not v2 repo

P2 open:
- 3072-dim Gemini embedding A/B
- BrainWriter `strict_mode=strict` flip (post 2026-04-27 validator-lint review)
- kos-worker `notionToBrain` sync (v1 repo)
- Crustdata / Proxycurl / PDL Tier 1
- **kos-patrol phase 4 gap-detection noise** (email-template column
  headers falsely flagged as entity gaps) — needs stoplist
- Stage 4 v1-archive (7d clean v2 soak)

---

## 6 · When this handoff is done

Per `skills/kos-jarvis/_runbook.md` §8 (handoff retirement):

1. Update the P1-A entry in `skills/kos-jarvis/TODO.md` from `[ ]`
   to `[x]` with execution date + final stats.
2. Update `docs/plans/P1-A-bulk-export-filesystem-canonical.md`
   with actual Phase 2 categorization numbers + Phase 5
   verification snapshot.
3. `git rm docs/SESSION-HANDOFF-P1A-FILESYSTEM-CANONICAL.md` (or
   leave for archive if you prefer).
4. Draft the next handoff for whatever's next (likely:
   "orphan-reducer at scale, now that markdown dual-write actually
   lands").

Don't let multiple handoff docs accumulate; they bit-rot fast.
