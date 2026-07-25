---
kind: dependency_management
name: Bun monorepo 依赖管理与锁定策略
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - bun.lock
    - admin/package.json
    - bunfig.toml
---

## 系统概览

gbrain 采用 **Bun** 作为统一的包管理器与运行时，通过单仓库（monorepo）形式管理核心引擎、管理前端（admin/）、技能注册表等子模块。依赖声明集中在根 `package.json`，并通过 `bun.lock` 锁定版本，确保构建可复现。

## 关键文件与约定

- **根 `package.json`**：声明所有生产与开发依赖、`bin` 入口、`exports` 多入口导出、`engines.bun` 版本约束、`trustedDependencies` 白名单以及 `postinstall` / `prepublish:clawhub` 钩子。
- **`bun.lock`**：Bun 的锁文件，记录每个包的精确版本与 sha512 校验值，workspaces 字段仅包含根工作区，未使用 workspace 引用协议。
- **`admin/package.json`**：管理后台独立子包，仅声明 React/Vite 相关依赖，由根脚本 `build:admin` 统一触发。
- **`bunfig.toml`**：全局测试超时与 preload 配置，间接影响依赖初始化行为（如 PGLite WASM 冷启动）。

## 架构与决策

1. **单一包管理器**：全仓只使用 Bun，不引入 npm/yarn/pnpm，避免多工具冲突。
2. **无 vendoring**：不将第三方源码纳入仓库，全部通过 `node_modules` + `bun.lock` 管理。
3. **信任依赖白名单**：`@electric-sql/pglite` 被显式加入 `trustedDependencies`，绕过 Bun 的安全沙箱以允许其原生扩展运行。
4. **安装后迁移**：`postinstall` 在本地安装时自动执行 `gbrain apply-migrations --yes`，保证数据库 schema 与代码同步。
5. **发布前构建**：`prepublish:clawhub` 先执行 `build:all` 生成多平台二进制，再调用 `clawhub package publish` 发布到 ClawHub 私有源。
6. **版本范围策略**：生产依赖普遍使用 `^` 或固定版本（如 `@electric-sql/pglite`、`tree-sitter-wasms`），开发依赖多为 `latest` 或 `^`，体现“稳定核心、灵活工具”的思路。
7. **引擎约束**：`engines.bun >= 1.3.10` 强制开发者与 CI 使用兼容的 Bun 版本。

## 开发者应遵循的规则

- **新增依赖**：仅在根 `package.json` 中声明，不要在各子目录重复声明；优先使用固定版本号以降低漂移风险。
- **原生扩展**：若引入含原生模块的包，需评估是否加入 `trustedDependencies`，并在 PR 中说明理由。
- **更新流程**：使用 `bun install` 更新后务必提交 `bun.lock`，禁止手动编辑锁文件。
- **发布准备**：执行 `bun run build:all` 生成二进制后再进行发布，确保 `prepublish:clawhub` 钩子行为一致。
- **环境隔离**：不要在 `.env` 或配置文件里硬编码依赖版本，统一走 `package.json` + `bun.lock`。
- **CI 一致性**：CI 流水线通过 `docker-compose.ci.yml` 与 `scripts/ci-local.sh` 复用同一套依赖解析逻辑，本地调试也应保持相同 Bun 版本。
