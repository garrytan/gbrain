# Session Handoff — pre v0.25.0 upstream sync

**Date**: 2026-05-01
**Previous session topic**: A 路线，Notion 超时根因排查 + kos-worker fetch timeout
**Next session topic**: B 路线，gbrain v0.22.9 → v0.25.0 上游同步
**Estimated work**: 2-3 h focused

---

## 上次 session 落地了什么（context for next "me"）

两个 commit 已 push 到 `origin/master`：

| Hash | Subject |
|---|---|
| `6f9339b` | port hygiene — sweep 7220 → 7225 fallbacks/docs + integration guide |
| `87a7536` | kos-worker fetch timeout — close the Notion-side cascade |

业务效果：
- KOS 服务全栈健康：launchd `com.jarvis.kos-compat-api` running，本地 7225 + 远端 `kos.chenge.ink` 都返回 `total_pages: 2424`，brain_score 83/100，schema v29
- Notion 超时不可达根因解决：Notion 边缘 worker 已重新部署（`ntn workers deploy`，4 tools registered），加了 240s AbortController + 明确 timeout 错误，env binding 也从 04-06 旧值（多半是 v1 Tailscale URL）刷成了 `https://kos.chenge.ink`
- Gemini 403：用户换卡解决；blog-qiaomu 那篇已补 embedding（2 chunks）
- OpenClaw 飞书 retry 雪崩根因：客户端 timeout 太短 + 同 URL 重发，`docs/integration-clients.md` 写清三条规则给 OpenClaw agent 作者参考

待 Lucien 人工验证（不阻塞 B 路线起步）：
- 在 Notion AI agent UI 重新触发 `https://blog.qiaomu.ai/ai-image-paper-2026` 摄入，确认不再"超时不可达"

---

## B 路线目标

把 fork 从 `v0.22.9` 升到上游 `v0.25.0`。三跳逐个并入：

```
v0.22.9 → v0.23.2 → v0.24.0 → v0.25.0
```

上游 HEAD 已 fetch 到 `upstream/master`，commit `736e8de`。CHANGELOG 已经读过。

---

## 三跳的核心要点

### 跳 1: v0.22.9 → v0.23.2（dream 修复 + 小修）

- 上游修了 dream orchestrator 自我消费 marker（v0.23.2 PR #527）
- **直接修我们 dream-cycle 的边角 bug**，所以这一跳是免费的修复
- 期望工作量：cherry-pick 几个 commit，无 conflict / 小 conflict
- 验证：`gbrain dream --phase orphans` 跑一次看 verdict 模型测试是否通过

### 跳 2: v0.23.2 → v0.24.0（skillify loop 生产硬化）

- skillify loop 从 dev preview 升级到 production-ready
- 我们没用 skillify 在 brain 上跑，所以业务影响小，但要确保 fork 的 skill 还能正确路由
- 期望工作量：可能 conflict 在 `skills/RESOLVER.md`（fork 在 `## KOS-Jarvis extensions` 段追加，需要保留）
- 验证：`gbrain check-resolvable` + 跑 `kos-patrol` 看 dashboard 是否仍正常

### 跳 3: v0.24.0 → v0.25.0（BrainBench-Real，**最大跳**）

- **BREAKING for custom engines**：`BrainEngine` 接口加 5 个新方法
  - `logEvalCandidate`
  - `listEvalCandidates`
  - `deleteEvalCandidatesBefore`
  - `logEvalCaptureFailure`
  - `listEvalCaptureFailures`
- **fork 的双引擎包装层 `skills/kos-jarvis/_lib/brain-db.ts` 必须补齐这 5 个方法**（Path 3 PGLite→Postgres 切换时引入的 dual-engine 包装）
- 看 `src/core/types.ts` 拿 return shape，照抄到 BrainDb
- schema migration v31（新增 `eval_candidates` + `eval_capture_failures` 表）
- 期望工作量：~1 h（5 个方法实现 + schema migration + 测试）
- 决策点：要不要启用 `GBRAIN_CONTRIBUTOR_MODE=1`？
  - 默认 OFF，对 user 完全透明
  - 启用后 query/search 写入 `eval_candidates` 表，PII 自动 scrub
  - 如果想给 fork 加 retrieval 回归测试，启用；否则不启用
  - 我建议：**不启用**。我们 brain 体量小（~2400 pages），retrieval 改动罕见，不需要 BrainBench-Real 那套。schema migration 该跑还跑，feature 不开

---

## 验证步骤（每跳之后必跑）

```bash
# 1. typecheck
bun run check

# 2. unit tests
bun test

# 3. brain health
gbrain doctor

# 4. dream cycle smoke
gbrain dream --phase orphans

# 5. kos-patrol smoke
bun run skills/kos-jarvis/kos-patrol/run.ts

# 6. /status 端到端
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  http://127.0.0.1:7225/status | jq .total_pages
```

最后一跳之后还要：

```bash
# 跑一次 schema migration
gbrain apply-migrations --yes

# 再次 doctor 确认 schema_version: 31
gbrain doctor --json | jq '.checks[] | select(.name=="schema_version")'
```

---

## 已知风险 / 注意事项

1. **fork 边界**：CLAUDE.md 第一条规则——所有 Jarvis 改动只能在 `skills/kos-jarvis/`。`src/`、`skills/RESOLVER.md` 主体段、其他 upstream `skills/*` 都不能改。
2. **Postgres 单库**：Path 3 之后 brain 已经在 Postgres 17 + pgvector 0.8.2 上跑，**不要回退到 PGLite**，dual-engine 包装层只是为了兼容 `BrainDb` 抽象，runtime 永远走 Postgres。
3. **WAL fork patch**：`pglite-schema.ts` 上有个我们的 fork patch（详见 v0.22.8 sync 记录），保留以维持 cold-backup 可行性。**v0.25.0 sync 时要确认这个 patch 在新版本下还成立**——如果上游 schema 大改导致冲突，要重新合到新基础上。
4. **Schema migration v31**：本次 sync 会触发 schema 升级，跑 `gbrain apply-migrations --yes`。如果之前的 brain 已经手动 set 过 `chunker_version`，注意是否需要重设。
5. **`docs/JARVIS-ARCHITECTURE.md` §6.18+**：sync 完成后追加一段记录这次升级（参考 §6.17 v0.22.8 sync 故事的写法）。

---

## 起手命令

```bash
cd /Users/chenyuanquan/Projects/jarvis-knowledge-os-v2

# 创建 sync 分支（避免直接在 master 上做长流程）
git checkout -b sync-v0.25.0

# 看这一波要 cherry-pick 什么
git log v0.22.9..upstream/master --oneline

# 看 v0.23.0 是从哪个 commit 开始
git log upstream/master --grep="v0.23.0" --oneline

# 起手第一跳
git cherry-pick <v0.23.0 起点>..<v0.23.2 终点>
```

或者按版本逐个 cherry-pick（更稳，每跳 commit + 测）。

---

## 完成定义

- [ ] `VERSION` 文件升到 `0.25.0`（fork 跟 upstream 版本号对齐，因为我们没有自己的版本号体系）
- [ ] `package.json` `version` 同步
- [ ] `bun test` 全绿
- [ ] `gbrain doctor` 全绿（schema_version: 31）
- [ ] `gbrain dream --phase orphans` 跑通
- [ ] `kos-patrol` dashboard 仍正常生成
- [ ] `/status` 远端 + 本地都返回正确 page 数
- [ ] `skills/kos-jarvis/_lib/brain-db.ts` 补齐 5 个 eval 方法
- [ ] `skills/kos-jarvis/TODO.md` Done 段加一条 v0.25.0 sync 记录
- [ ] `docs/JARVIS-ARCHITECTURE.md` 加 §6.20 记录升级
- [ ] commit + push

---

## 给下次"我"的 1-line summary

> A 路线全部闭环。代码仓库干净。Notion edge 已重新部署。等用户拍板开 B 路线时直接 cherry-pick `v0.22.9..upstream/master`，按本文件三跳推进，重点把 v0.25.0 的 5 个 BrainEngine 新方法补到 fork 的 `_lib/brain-db.ts`。
