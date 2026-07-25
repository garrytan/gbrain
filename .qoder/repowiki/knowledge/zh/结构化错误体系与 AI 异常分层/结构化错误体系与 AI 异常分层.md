---
kind: error_handling
name: 结构化错误体系与 AI 异常分层
category: error_handling
scope:
    - '**'
source_files:
    - src/core/types.ts
    - src/core/errors.ts
    - src/core/ai/errors.ts
    - src/core/brain-registry.ts
    - src/commands/code-def.ts
    - src/commands/skillopt.ts
    - src/commands/serve-http.ts
    - src/core/ai/gateway.ts
---

## 1. 系统概览

gbrain 采用「三层错误模型」：面向 Agent/CLI 的结构化错误信封、面向业务域的 GBrainError 层次、以及面向外部 AI 服务的专用异常族。所有错误均遵循「可诊断 + 可恢复」原则，通过 `problem/cause_description/fix` 三元组或 `{class, code, message, hint}` 信封向上层传递，避免裸 `throw new Error()` 丢失语义。

## 2. 核心类型与文件

- **顶层基类** `GBrainError`（`src/core/types.ts:1547`）
  构造函数 `(problem, cause_description, fix, docs_url?)`，统一输出 `problem: cause_description. Fix: fix` 的易读消息，被 mounts/brain 注册等配置校验广泛使用。

- **Agent 结构化错误**（`src/core/errors.ts`）
  - `StructuredError` 接口：`{ class, code, message, hint?, docs_url? }`，对应 v0.17+ `PhaseResult.error` 契约。
  - `buildError(input)` / `errorFor(input)`：构造并抛出信封。
  - `StructuredAgentError extends Error`：携带 `.envelope`，供上层 catch 后以 JSON `{error: envelope}` 返回给 OpenClaw 等 Agent。
  - `serializeError(value)`：兜底把任意 throwable 归一化为信封（未知错误降级为 `{class:'Error', code:'unknown'}`）。

- **AI 服务异常族**（`src/core/ai/errors.ts`）
  - `AIServiceError` 基类；`AIConfigError`（用户修复：缺 key、维度不匹配、4xx）；`AITransientError`（可重试：5xx/超时/网络抖动）。
  - `normalizeAIError(err, context?)`：按 HTTP status + SDK name 将第三方错误映射到上述三类，未知错误默认归为 transient，保证调用方可安全重试。

- **领域细分错误**（散落在各模块，示例）
  - `DuplicateMountPathError` / `UnknownBrainError` 继承自 `GBrainError`（`src/core/brain-registry.ts`）
  - `EmbeddingDimMismatchError`、`SyncLockBusyError`、`AbortError`、`BudgetExhausted` 等各自 `extends Error`，用于特定子系统边界。

## 3. 架构与约定

| 层面 | 何时使用 | 典型位置 |
|---|---|---|
| `GBrainError` | 配置/参数校验失败，需要明确 `fix` 指导用户操作 | `brain-registry.ts`、`db.ts`、`calibration/gstack-coupling.ts` |
| `StructuredAgentError` / `buildError` | CLI/HTTP 对外暴露给 Agent 的错误，需带稳定 `code` 和可选 `hint/docs_url` | `commands/code-def.ts`、`commands/skillopt.ts`、`commands/serve-http.ts` |
| `AIConfigError` / `AITransientError` | 包装 Vercel AI SDK 或上游 LLM 调用异常，驱动重试/回退策略 | `ai/gateway.ts`、`ai/errors.ts` |
| 裸 `Error` 子类 | 仅内部子系统边界（如 `AbortError`、`BudgetExhausted`），不直接暴露给 Agent | 各子目录内局部使用 |

- **序列化出口**：命令层统一在 `try/catch` 中捕获异常，用 `serializeError(e)` 产出信封，再以 `{error: envelope}` JSON 打印；HTTP 网关同样走 `serializeError` 返回标准 payload。
- **AI 异常归一化**：gateway 层在 `resolveRecipe`、`assertTouchpoint` 等处捕获异常，若为 `AIConfigError` 则转为 `{ok:false, reason, detail, fix}` 的探测结果，否则透传，确保「配置错误硬失败、网络错误可重试」。

## 4. 开发者规则

1. **对外暴露的错误必须结构化**：新 API/CLI 面优先使用 `errorFor({ class, code, message, hint?, docs_url? })`，让 Agent 能区分 retryable vs fatal。
2. **用户输入/配置校验抛 `GBrainError`**：提供三要素 `problem`、`cause_description`、`fix`，禁止吞掉提示。
3. **AI 调用一律经 `normalizeAIError`**：不要直接 throw SDK 原始错误；让上层根据 `AIConfigError`/`AITransientError` 决定重试或回退。
4. **禁止裸 `throw new Error('...')` 跨边界传播**：仅在函数内部短路时使用，并在最外层由 `serializeError` 兜底归一化。
5. **错误码命名**：`code` 字段使用 snake_case 且全局唯一，便于 Agent 侧 switch-case 处理。
6. **文档链接**：当存在 runbook 时附带 `docs_url`，帮助人类快速定位排障步骤。

## 5. 关键文件清单

- `src/core/types.ts` — `GBrainError` 基类定义
- `src/core/errors.ts` — `StructuredError` 信封、`StructuredAgentError`、`buildError`/`errorFor`/`serializeError`
- `src/core/ai/errors.ts` — `AIServiceError` / `AIConfigError` / `AITransientError` 及 `normalizeAIError`
- `src/core/brain-registry.ts` — `DuplicateMountPathError`、`UnknownBrainError` 等挂载相关错误
- `src/commands/code-def.ts`、`src/commands/code-callers.ts`、`src/commands/skillopt.ts`、`src/commands/serve-http.ts` — 命令层统一 `serializeError` 出口示例
- `src/core/ai/gateway.ts` — AI 异常归一化与 fail-open guardrail 边界
