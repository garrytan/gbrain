---
kind: build_system
name: 构建与制品管理 — Bun 单仓 + 多阶段 CI 流水线
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - bunfig.toml
    - tsconfig.json
    - admin/package.json
    - scripts/build-admin-embedded.ts
    - scripts/ci-local.sh
    - docker-compose.ci.yml
    - scripts/run-unit-parallel.sh
    - scripts/test-shard.sh
    - scripts/sharding.ts
    - .github/workflows/test.yml
    - .github/workflows/e2e.yml
    - .github/workflows/release.yml
---

## 1. 系统概览
本项目采用 **Bun monorepo** 形态，以 `package.json` 为单一入口，通过 `scripts/` 下的 shell/TS 脚本统一编排编译、测试、校验与发布；前端 Admin SPA 使用 Vite 独立构建后嵌入到 gbrain CLI 二进制中。CI 基于 GitHub Actions，按“内容哈希缓存 → verify/gitleaks → 串行测试 → 矩阵分片 → E2E（含真实 Postgres）→ 跨平台产物”的多阶段流水线组织。

## 2. 关键文件与包
- 根级构建配置：`package.json`（`build`/`build:all`/`build:admin`/`test`/`verify`/`ci:*` 等 script）、`bunfig.toml`（全局 test timeout + 预加载）、`tsconfig.json`（ESNext + bun-types + `@/*` path alias）
- 前端子模块：`admin/package.json` + `vite.config.ts`，由 `scripts/build-admin-embedded.ts` 打包并内嵌进 CLI
- 本地 CI 编排：`docker-compose.ci.yml`（4 个 pgvector 实例 + pgbouncer + oven/bun:1 runner），`scripts/ci-local.sh`（完整镜像 GH Actions 的本地 gate）
- 测试分片与并行：`scripts/run-unit-parallel.sh`（自动 CPU 探测 + 心跳聚合）、`scripts/test-shard.sh`（LPT 权重感知分片）、`scripts/sharding.ts`、`scripts/test-weights.json`
- CI 工作流：`.github/workflows/test.yml`（cache-check / verify / serial / slow-eval / matrix(10) / cache-write / test-status）、`.github/workflows/e2e.yml`（Tier1/Tier2 + JSONB parity guard）、`.github/workflows/release.yml`（darwin-arm64 + linux-x64 交叉编译）
- 版本与发布：`VERSION` 文件 + `package.json.version`，release 触发条件 `tags/v*`

## 3. 架构与约定
### 3.1 构建产物
- CLI 二进制：`bun build --compile --target=<目标> --outfile bin/gbrain-* src/cli.ts`，支持 `--target=bun-darwin-arm64` 与 `--target=bun-linux-x64` 双平台交叉编译
- Admin 前端：`cd admin && vite build` 产出静态资源，再由 `scripts/build-admin-embedded.ts` 注入到 gbrain 二进制
- PGLite WASM 快照：`scripts/build-pglite-snapshot.ts` 生成 `test/fixtures/pglite-snapshot.tar`，供 E2E 快速冷启动

### 3.2 测试分层与分片
- 单元测试：`run-unit-parallel.sh` 根据物理核数（上限 8，默认 4）并行启动多个 `run-unit-shard.sh`，每个 shard 调用 `test-shard.sh` 做 LPT 权重感知分片，再 `xargs bun test --timeout=60000` 执行；完成后串行跑 `*.serial.test.ts`
- E2E：`scripts/run-e2e.sh` 配合 `docker-compose.ci.yml` 的 4 个 postgres 实例做 4-way sharding，避免 TRUNCATE CASCADE 竞争；`scripts/select-e2e.ts` 提供 diff-aware 选择器（doc-only 直接跳过）
- 慢用例隔离：`eval-longmemeval-e2e.slow.test.ts` 与 `entity-resolve-perf.slow.test.ts` 从矩阵中抽离为独立 job，防止单个长任务拖垮分片
- 全局超时：`bunfig.toml` 设置 `timeout = 60_000`，并通过 `preload` 注入 `legacy-embedding-preload.ts` 锁定旧版 embedding 维度，保证 fixture 兼容

### 3.3 CI 缓存与门禁
- 内容哈希缓存：`scripts/ci-cache-hash.sh` 对受控文件集计算 16 字符 hash，`actions/cache` 以 `ci-pass-<hash>` 键命中则跳过全部测试，仅保留 gitleaks 扫描
- 门禁前置：`verify` 并行运行 20+ 个 `check-*.sh`（隐私、JSONB 模式、source-id 投影、WASM 嵌入、exports 计数、admin 构建一致性等）
- 安全扫描：gitleaks 在 PR 推送时全仓库扫描，本地 `ci-local.sh --diff` 也支持 doc-only 快速路径

### 3.4 发布流程
- 触发：push tag `v*` 即触发 `.github/workflows/release.yml`
- 构建：在 macos-latest 与 ubuntu-latest 上分别用 `bun build --compile --target=...` 产出 `bin/gbrain-darwin-arm64` 与 `bin/gbrain-linux-x64` 作为 artifact
- 发布：`softprops/action-gh-release` 将两个二进制上传至对应 release

## 4. 开发者应遵循的规则
1. **新增依赖**：优先通过 `bun add` 更新 `bun.lock`，不要手动编辑 lockfile；若引入原生模块，确认已列入 `trustedDependencies`。
2. **新增测试**：新文件自动被 `test-shard.sh` 纳入分片；如需串行或排除，请显式命名 `*.serial.test.ts` 或调整 `test-shard.sh` 的 exclude 列表并在注释中说明原因。
3. **慢用例处理**：超过 ~150s 的用例应拆出为独立 job 或在 `test-shard.sh` 中排除，避免破坏矩阵均衡。
4. **本地 CI 对齐**：提交前运行 `bun run ci:local`（或 `--diff` 快速路径）复现 GH Actions 行为；端口冲突时使用 `GBRAIN_CI_PG_PORT` 覆盖。
5. **跨平台构建**：发布前可先执行 `bun run build:all` 验证 darwin-arm64 与 linux-x64 均能编译成功。
6. **Admin 变更**：修改 `admin/` 后需运行 `bun run build:admin` 重新嵌入，否则 `check:admin-build` 会失败。
7. **版本管理**：版本号集中在 `VERSION` 与 `package.json.version`，发布只认 `v*` tag，不要在分支上手动打 tag。