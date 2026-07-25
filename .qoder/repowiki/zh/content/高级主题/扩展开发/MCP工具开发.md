# MCP工具开发

<cite>
**本文引用的文件**   
- [src/mcp/index.ts](file://src/mcp/index.ts)
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [test/mcp-client.test.ts](file://test/mcp-client.test.ts)
- [test/mcp-tool-defs.test.ts](file://test/mcp-tool-defs.test.ts)
- [test/mcp-dispatch-summarize.test.ts](file://test/mcp-dispatch-summarize.test.ts)
- [scripts/smoke-test-mcp.ts](file://scripts/smoke-test-mcp.ts)
</cite>

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖分析](#依赖分析)
7. [性能考虑](#性能考虑)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录](#附录)

## 简介
本指南面向希望基于MCP协议在项目中实现、注册与调用工具的开发者。内容覆盖：
- 工具定义、参数规范与返回格式
- 工具注册机制、调用流程与错误处理
- 安全模型、权限控制与资源访问限制
- 异步工具、流式工具与批处理工具的实现模式
- 测试方法、调试技巧与性能监控
- 第三方服务集成最佳实践与认证处理

## 项目结构
围绕MCP工具能力，仓库中相关代码主要分布在以下模块：
- src/mcp：MCP入口与对外导出
- src/core：MCP客户端/服务端、工具注册表、安全策略、流式与批处理、错误类型与公共类型
- test：针对MCP客户端、工具定义、调度汇总等的测试用例
- scripts：MCP冒烟测试脚本

```mermaid
graph TB
A["src/mcp/index.ts"] --> B["src/core/mcp-client.ts"]
A --> C["src/core/mcp-server.ts"]
A --> D["src/core/mcp-tool-registry.ts"]
A --> E["src/core/mcp-security.ts"]
A --> F["src/core/mcp-streaming.ts"]
A --> G["src/core/mcp-batch.ts"]
A --> H["src/core/mcp-errors.ts"]
A --> I["src/core/mcp-types.ts"]
J["test/mcp-client.test.ts"] --> B
K["test/mcp-tool-defs.test.ts"] --> D
L["test/mcp-dispatch-summarize.test.ts"] --> C
M["scripts/smoke-test-mcp.ts"] --> B
```

图表来源
- [src/mcp/index.ts](file://src/mcp/index.ts)
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [test/mcp-client.test.ts](file://test/mcp-client.test.ts)
- [test/mcp-tool-defs.test.ts](file://test/mcp-tool-defs.test.ts)
- [test/mcp-dispatch-summarize.test.ts](file://test/mcp-dispatch-summarize.test.ts)
- [scripts/smoke-test-mcp.ts](file://scripts/smoke-test-mcp.ts)

章节来源
- [src/mcp/index.ts](file://src/mcp/index.ts)
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [test/mcp-client.test.ts](file://test/mcp-client.test.ts)
- [test/mcp-tool-defs.test.ts](file://test/mcp-tool-defs.test.ts)
- [test/mcp-dispatch-summarize.test.ts](file://test/mcp-dispatch-summarize.test.ts)
- [scripts/smoke-test-mcp.ts](file://scripts/smoke-test-mcp.ts)

## 核心组件
- 工具定义与类型：集中描述工具元数据、参数Schema与返回结构，确保跨进程/跨语言一致。
- 工具注册表：维护工具清单、版本兼容性与发现接口，支持动态增删改查。
- 客户端与服务端：分别负责工具发现、调用封装与路由分发、结果序列化。
- 安全策略：鉴权、授权、资源白名单与审计日志。
- 流式与批处理：对长耗时或大数据量场景提供增量输出与批量执行能力。
- 错误体系：统一错误码、可诊断信息与重试策略。

章节来源
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)

## 架构总览
下图展示了从调用方到工具实现的端到端路径，包括注册、鉴权、调度、执行与结果回传。

```mermaid
sequenceDiagram
participant Caller as "调用方"
participant Client as "MCP客户端"
participant Registry as "工具注册表"
participant Security as "安全策略"
participant Server as "MCP服务端"
participant Tool as "工具实现"
Caller->>Client : "发起工具调用(名称, 参数)"
Client->>Registry : "解析工具定义/校验参数"
Registry-->>Client : "返回工具元数据"
Client->>Security : "鉴权与资源访问检查"
Security-->>Client : "通过/拒绝"
Client->>Server : "转发调用请求"
Server->>Tool : "执行业务逻辑"
Tool-->>Server : "返回结果/流式片段"
Server-->>Client : "聚合响应"
Client-->>Caller : "最终结果"
```

图表来源
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)

## 详细组件分析

### 工具定义与类型
- 工具元数据：包含名称、版本、描述、参数Schema与返回Schema等字段，用于生成文档与校验。
- 参数规范：遵循JSON Schema风格，支持必填/可选、默认值、枚举、范围约束等。
- 返回格式：结构化数据优先，必要时附带进度事件与附件引用。

```mermaid
classDiagram
class 工具定义 {
+字符串 名称
+字符串 版本
+字符串 描述
+对象 参数Schema
+对象 返回Schema
+布尔 是否流式
+布尔 是否批处理
}
class 参数校验器 {
+校验(参数) 结果
+提示(错误) 消息
}
class 返回格式化器 {
+格式化(原始结果) 标准化结果
+附加进度(事件) 追加
}
工具定义 --> 参数校验器 : "使用"
工具定义 --> 返回格式化器 : "使用"
```

图表来源
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)

章节来源
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [test/mcp-tool-defs.test.ts](file://test/mcp-tool-defs.test.ts)

### 工具注册表
- 职责：维护工具清单、版本兼容性、发现接口；支持按命名空间/标签筛选。
- 行为：注册/注销、查询、变更通知；与客户端缓存同步。

```mermaid
flowchart TD
Start(["开始"]) --> Register["注册工具定义"]
Register --> Validate{"定义有效?"}
Validate --> |否| Error["记录错误并拒绝"]
Validate --> |是| Store["持久化/内存存储"]
Store --> Notify["通知订阅者"]
Notify --> End(["结束"])
Error --> End
```

图表来源
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)

章节来源
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [test/mcp-tool-defs.test.ts](file://test/mcp-tool-defs.test.ts)

### 客户端与服务端
- 客户端：负责工具发现、参数校验、鉴权前置、请求编排与结果反序列化；支持重试与超时。
- 服务端：负责路由分发、上下文注入、限流与审计；对接具体工具实现。

```mermaid
sequenceDiagram
participant C as "客户端"
participant S as "服务端"
participant R as "注册表"
participant Sec as "安全策略"
participant T as "工具实现"
C->>R : "获取工具列表/详情"
R-->>C : "返回工具元数据"
C->>Sec : "鉴权(令牌/角色/资源)"
Sec-->>C : "授权结果"
C->>S : "调用工具(名称, 参数)"
S->>T : "分发到实现"
T-->>S : "返回结果"
S-->>C : "响应"
```

图表来源
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)

章节来源
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [test/mcp-client.test.ts](file://test/mcp-client.test.ts)
- [test/mcp-dispatch-summarize.test.ts](file://test/mcp-dispatch-summarize.test.ts)

### 安全模型与权限控制
- 身份与令牌：支持Bearer Token、会话上下文与短期凭证。
- 授权策略：基于角色的访问控制（RBAC）与资源级白名单。
- 审计与追踪：记录调用链、输入摘要与结果摘要，便于合规与排障。
- 最小权限原则：仅暴露必要工具与资源路径。

```mermaid
flowchart TD
A["接收调用"] --> B["提取身份令牌"]
B --> C{"令牌有效?"}
C --> |否| Deny["拒绝并记录审计"]
C --> |是| D["解析角色与资源范围"]
D --> E{"是否允许访问目标工具/资源?"}
E --> |否| Deny
E --> |是| F["放行并注入上下文"]
F --> G["继续执行"]
```

图表来源
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)

章节来源
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)

### 异步工具、流式工具与批处理工具
- 异步工具：返回Promise或JobID，客户端轮询或通过回调获取结果。
- 流式工具：以事件流形式逐步产出中间结果，适合大文本/分块数据。
- 批处理工具：接受数组输入，内部并行/分片执行，返回聚合结果与明细状态。

```mermaid
sequenceDiagram
participant C as "客户端"
participant S as "服务端"
participant ST as "流式处理器"
participant B as "批处理引擎"
C->>S : "启动流式任务"
loop 增量输出
S->>ST : "推送事件"
ST-->>C : "事件片段"
end
C->>S : "提交批处理任务(数组)"
S->>B : "分片执行"
B-->>S : "阶段进度"
S-->>C : "进度事件"
B-->>S : "聚合结果"
S-->>C : "最终结果"
```

图表来源
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)

章节来源
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)

### 错误处理与诊断
- 错误分类：参数错误、鉴权失败、资源不可用、超时、内部异常等。
- 统一响应：包含错误码、消息、建议修复动作与追踪ID。
- 重试与退避：对瞬时错误采用指数退避与最大重试次数。

```mermaid
flowchart TD
Start(["进入工具执行"]) --> Try["尝试执行业务逻辑"]
Try --> Ok{"成功?"}
Ok --> |是| Return["返回结果"]
Ok --> |否| Classify["分类错误类型"]
Classify --> Retryable{"可重试?"}
Retryable --> |是| Backoff["指数退避"]
Backoff --> Retry["重试"]
Retry --> Try
Retryable --> |否| Format["格式化错误响应"]
Format --> Audit["写入审计日志"]
Audit --> Return
```

图表来源
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)

章节来源
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)

## 依赖分析
- 内聚性：各组件职责清晰，类型与错误体系共享，降低耦合。
- 外部依赖：网络传输、认证提供者、数据库/对象存储等由上层注入。
- 潜在循环：注册表不应反向依赖客户端/服务端，避免环依赖。

```mermaid
graph LR
Types["mcp-types.ts"] --> Registry["mcp-tool-registry.ts"]
Types --> Client["mcp-client.ts"]
Types --> Server["mcp-server.ts"]
Security["mcp-security.ts"] --> Client
Security --> Server
Streaming["mcp-streaming.ts"] --> Server
Batch["mcp-batch.ts"] --> Server
Errors["mcp-errors.ts"] --> Client
Errors --> Server
```

图表来源
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)

章节来源
- [src/core/mcp-types.ts](file://src/core/mcp-types.ts)
- [src/core/mcp-tool-registry.ts](file://src/core/mcp-tool-registry.ts)
- [src/core/mcp-client.ts](file://src/core/mcp-client.ts)
- [src/core/mcp-server.ts](file://src/core/mcp-server.ts)
- [src/core/mcp-security.ts](file://src/core/mcp-security.ts)
- [src/core/mcp-streaming.ts](file://src/core/mcp-streaming.ts)
- [src/core/mcp-batch.ts](file://src/core/mcp-batch.ts)
- [src/core/mcp-errors.ts](file://src/core/mcp-errors.ts)

## 性能考虑
- 参数校验与Schema预编译：减少运行时开销。
- 连接复用与池化：HTTP/STDIO连接池，避免频繁握手。
- 流式输出：降低峰值内存占用，提升首字节延迟。
- 批处理分片：根据CPU/IO特性设置并发度与批次大小。
- 缓存热点：对只读工具结果进行短TTL缓存。
- 指标与追踪：采集QPS、P95/P99延迟、错误率与吞吐。

[本节为通用指导，不直接分析具体文件]

## 故障排查指南
- 常见问题
  - 参数校验失败：检查Schema必填项与类型约束。
  - 鉴权失败：确认令牌有效期、角色与资源白名单。
  - 超时/重试风暴：调整超时阈值与退避策略。
  - 流式中断：检查网络稳定性与背压处理。
- 定位手段
  - 启用审计日志与追踪ID，关联上下游。
  - 使用冒烟脚本快速验证端到端链路。
  - 单元测试聚焦边界条件与错误分支。

章节来源
- [test/mcp-client.test.ts](file://test/mcp-client.test.ts)
- [scripts/smoke-test-mcp.ts](file://scripts/smoke-test-mcp.ts)

## 结论
通过统一的工具定义、严格的注册与鉴权、完善的错误与流式/批处理支持，MCP工具可在多环境稳定运行。建议在生产环境强化审计与指标采集，持续优化参数校验与连接复用策略，保障高可用与低延迟。

[本节为总结性内容，不直接分析具体文件]

## 附录
- 第三方服务集成最佳实践
  - 使用短期凭证与密钥轮换，避免硬编码。
  - 对敏感参数脱敏后入审计日志。
  - 建立熔断与降级策略，保护上游服务。
- 认证处理方式
  - 支持OAuth2/OIDC、API Key与证书双向认证。
  - 将令牌生命周期管理与工具调用解耦。

[本节为通用指导，不直接分析具体文件]