# Notion Jarvis ↔ kos-worker 使用指南

> Audience: Notion Jarvis(Notion AI agent + kos-worker tools)
> Author: Lucien × Jarvis v2, 2026-04-17
> 状态:kos-worker 已经在 Notion 侧部署,端到端链路已跑通。本文告诉 Notion Jarvis 在日常处理信息时怎么调用。

## 你是什么,能拿到什么

你是 Notion 里的 AI 助手,你拥有一个名为 `kos-worker` 的 Notion Worker(已部署,workspace 里可见)。它暴露 **4 个工具**,底下对接住在 Lucien Mac 上、通过 `https://kos.chenge.ink` 暴露的 **kos-compat-api**,后者又 wrap 了 128+ 页、Gemini 向量化、pglite 持久化的 `gbrain`。

所以你能做两件事:
1. **问 brain**:中文/英文自然语言问题,拿回跨来源综合答案
2. **写 brain**:把此刻在 Notion 里看到的有价值内容(文章 URL / 手头的 markdown 正文)推进 brain,之后所有 Notion / 飞书 / CLI 查询都能检索到

## 架构位置

```
  Lucien in Notion
        │
        ▼
  Notion Jarvis (你)
        │ 调用工具
        ▼
  kos-worker  (已部署 Notion Worker)
        │ HTTPS Bearer
        ▼
  https://kos.chenge.ink  →  kos-compat-api:7225 on Mac
        │ gbrain CLI
        ▼
  gbrain (Postgres + Gemini embeds)  ←  enrich-sweep / kos-patrol 周期任务
```

> **2026-05-17 update**: `notion-poller` 已 **RETIRED**(production probe
> 显示 24+ h × 0 net ingest, 详 `docs/JARVIS-ARCHITECTURE.md` §6.27)。
> 邮件路径将由 mailagent v4 SQLite SSoT 直接推送到 `/ingest`(方案 B,
> tracked in GitHub issue)。除邮件之外的非 DB 来源(URL / 粘贴正文 /
> meeting notes)和**任何查询**仍然由你(kos-worker)负责。

## 工具清单

### 1. `kosQuery` — 检索知识库

**何时用**

- Lucien 问"我之前看过的 XX 怎么说来着?"
- 写 PRD 时需要回忆 harness engineering / context engineering / agent 架构相关的既有判断
- 起草某个人的简介时想看看 brain 里有没有他的页面
- 任何时候你不确定某个概念的精确定义

**不要用**

- 你自己能直接答出、**不依赖 Lucien 私有语境**的问题(比如"React 是什么")。浪费 token。
- 需要最新实时信息的问题(比如今天某个股票价格)。brain 是知识层,不是实时层。

**参数**

- `question`(必填,字符串):中文优先,完整自然句。一次一个问题。

**返回**

一段编译级的综合回答,会引用 `[concept:xxx]` / `[source:xxx]` / `[decision:xxx]` 这种内部页面标识。你可以在给 Lucien 的回复里保留这些引用标识或转译成"见 xxx"。

**示例**

```
调用:kosQuery({ question: "Jarvis 为什么选 OpenClaw 而不是自己写 harness?" })
返回:(引用 decisions/harness-evaluation-separation + syntheses/three-agent-execution-topology 综合答复...)
```

---

### 2. `kosIngest` — 摄入内容到知识库 ⭐️ 本轮重点扩展

**v2 的新能力(2026-04-17)**

原 v1 只接受 `url` 参数,让服务端去 fetch。现在同时接受 `markdown` 参数 — 如果你手头已经有正文(比如 Lucien 在 Notion 里贴了一段 PRD / 会议纪要 / 邮件摘要),直接把 markdown 传过去,服务端不再 fetch,直接入库。

**何时用 `markdown` 路径**

- Lucien 在对话里说:"这段内容很有价值,帮我存到知识库"
- 你看到某个 Notion 页面(非受 poller 监控的 DB)值得长期保留
- Lucien 粘贴邮件、聊天记录、论文段落,希望沉淀

**何时用 `url` 路径**

- Lucien 发来某篇文章链接,要 brain 存一份
- 某个 Blog / Twitter thread 链接

**何时都不要调**

- Lucien 只是闲聊,内容不值得长期保留
- 内容已经在监控 DB 里:notion-poller 会自己处理,不要重复摄入
- 内容是生成式的(你自己刚总结出的 summary,除非 Lucien 明确让你存)

**参数**

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string? | 要摄入的 URL。与 `markdown` 二选一。 |
| `markdown` | string? | 要摄入的 markdown 正文。可以带自己的 YAML frontmatter(以 `---` 开头),也可以不带(服务端会补默认)。 |
| `title` | string? | 页面标题,强烈建议填写。默认从 URL/markdown 推断(容易丑)。 |
| `slug` | string? | 自定义英文短横线 slug,默认从 title 生成。 |
| `kind` | string? | 页面类型。默认 `source`。其他可选:`concept / project / decision / synthesis / protocol / timeline / comparison / entity`。绝大多数情况保持 `source`。 |
| `source` | string? | 来源标识,默认从 URL / notion_id 推断。手动场景写 `manual:<描述>`。 |
| `notion_id` | string? | 如果这段内容来自某个 Notion 页面,把页面 UUID 传过来,会进 frontmatter 便于溯源。 |
| `tags` | string[]? | 额外标签,追加到 frontmatter.tags。 |

**示例 1:用户粘贴的 meeting 纪要**

```
调用:
kosIngest({
  title: "2026-04-17 Omada 周会要点",
  markdown: "- 决定把 MR-HD 的 roadmap 延后一个 sprint\n- Lucien 负责写 PRD 并 loop Alex\n- 下次同步:下周二",
  kind: "source",
  source: "manual:omada-weekly-2026-04-17",
  tags: ["meeting", "omada"]
})
返回: { imported: true, embedded: true, slug: "2026-04-17-omada-..." }
```

**示例 2:Notion 页面推进 brain**

```
用户在和你聊时引用了自己写的一个 Notion 页面。你通过 Notion SDK 拿到了页面 blocks → 转成 markdown → 调 ingest:
kosIngest({
  title: "Jarvis Phase 4 Calendar 设计草案",
  markdown: "(Notion 页面转出来的 markdown 全文)",
  kind: "project",
  notion_id: "<page_id>",
  source: "notion:<page_id>",
  tags: ["design-doc", "phase-4"]
})
```

**示例 3:Lucien 发来一篇文章链接**

```
kosIngest({ url: "https://www.anthropic.com/news/xxx" })
```
这和原 v1 行为完全一样,URL fetch 路径保留。

---

### 3. `kosDigest` — 最近 N 天的知识库变动

**何时用**

- Lucien 说"最近 brain 有什么新东西?"
- 周日晚上生成周度总结
- 你需要在某个上下文下知道"最近热点是什么"

**参数**

- `since`(可选,number):回溯天数,默认 7。

**返回**

一段结构化文本(通常是 kos-patrol 产生的 `[knowledge-os] YYYY-MM-DD patrol: ...` 开头的 digest),包含:页面数、新增数量、lint 错误、entity gaps、近期编译热点等。

---

### 4. `kosStatus` — 健康快照

**何时用**

- Lucien 问"brain 现在什么状况?"
- 你怀疑 brain 不健康(比如 ingest 调用失败,想先确认服务在不在)
- 文档里提到某个数字(页面数、分布)时,可以拉一次确认

**参数**

- 无

**返回**

```json
{ "total_pages": 128, "by_type": { "source": 48, "concept": 29, ... }, "engine": "gbrain (pglite)", "brain": "/Users/..." }
```

---

## 配合 notion-poller 的分工

Lucien 会把**固定的几个 Notion 数据库**配到 notion-poller 监控列表里(典型:`Reading List`,`Meeting Notes`,`Ideas`)。那些 DB 的页面:

- 你**不要**主动 `kosIngest` 里面的页面(会导致重复)
- 你**可以**对其中的页面调 `kosQuery` 以外的任何操作(比如读 / 改 / 总结)
- 如果发现某个 DB 里的内容 24 小时后还没出现在 brain(通过 `kosQuery` 搜不到),提醒 Lucien 检查 notion-poller 健康

对**未被 poller 监控的来源**(临时对话 / 一次性页面 / URL / 邮件 / 聊天截图转文字):用 `kosIngest` 主动入库。

## 错误模式和兜底

| 症状 | 可能原因 | 你应该做 |
|---|---|---|
| `kosIngest` 返回 502 | 上游 URL fetch 失败(比如 404 / CF 拦截) | 告诉 Lucien,建议他**手动复制内容为 markdown 再调一次** |
| `kosIngest` 返回 embedded=false | Gemini shim 临时挂了 | 报告 "imported but not embedded — 稍后自动重试"。Lucien 的 Mac 端会修 |
| `kosQuery` 返回空或低相关 | 问题太宽,或 brain 真的没内容 | 换一个更具体的问法再试一次;还是不行就告诉 Lucien "这个问题 brain 里没有明确记录" |
| 连接超时 / 401 | compat-api 挂了 / token 过期 | 直接告诉 Lucien "kos-compat-api 不可达,检查 launchd" |

## 本次更新完成后,你需要记住的 3 件事

1. **`kosIngest` 现在能接 markdown 了**,不用再逼用户把粘贴内容先发出去变成 URL
2. **有个叫 notion-poller 的 cron 在自动 ingest 受监控 DB**,不要和它重复干活
3. **其他工具(kosQuery / kosDigest / kosStatus)参数和行为没变**

---

## Appendix: kos-worker 部署方

```bash
cd workers/kos-worker
npm run check        # typecheck
ntn workers deploy   # 推到 Notion
ntn workers env push # 如果改了 .env
```

部署文件:`workers/kos-worker/src/index.ts`
当前版本:0.2.0(markdown ingest)
前版本:0.1.0(只支持 url)
