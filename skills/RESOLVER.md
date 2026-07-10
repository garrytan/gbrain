# GBrain 技能解析器（Skill Resolver）

这是调度器。技能是具体实现。**在执行前阅读技能文件。** 如果两个技能都可能匹配，请阅读两个。它们设计为可以链式调用（例如，针对每个实体先摄取再丰富）。

## 始终开启（每条消息）

| 触发器 | 技能 |
|---------|-------|
| 每条入站消息（并行生成，不阻塞） | `skills/signal-detector/SKILL.md` |
| 任何大脑读取/写入/查找/引用 | `skills/brain-ops/SKILL.md` |

## 大脑操作

| 触发器 | 技能 |
|---------|-------|
| "我们知道关于...的什么"、"告诉我关于...的信息"、"搜索..."、"...是谁"、"...的背景"、"关于...的笔记" | `skills/query/SKILL.md` |
| "谁认识谁"、"之间的关系"、"连接"、"图查询" | `skills/query/SKILL.md`（使用 graph-query） |
| 创建/丰富人物或公司页面 | `skills/enrich/SKILL.md` |
| 新文件应该放在哪里？归档规则 | `skills/repo-architecture/SKILL.md` |
| "这个大脑页面应该放在哪里"、"将这个归档到大脑中"、"大脑分类学家"、"分类检查"、"重新归档大脑页面"、"这个页面应该放在哪个目录" | `skills/brain-taxonomist/SKILL.md` |
| "EIIRP"、"各就各位"、"存储这个研究"、"将这个放入大脑"、"使这个可重做"、"DRY 这个"、"归档所有这些"、"组织所有这项工作"、"归档这个研究线程" | `skills/eiirp/SKILL.md` |
| 修复大脑页面中的断开引用 | `skills/citation-fixer/SKILL.md` |
| "引用审计"、"检查引用"、"修复引用" | `skills/citation-fixer/SKILL.md`（集中修复）。对于更广泛的大脑健康，链式调用到 `skills/maintain/SKILL.md` |
| "研究"、"跟踪"、"从电子邮件中提取"、"投资者更新"、"捐赠" | `skills/data-research/SKILL.md` |
| 将大脑页面作为链接共享 | `skills/publish/SKILL.md` |
| "验证前置元数据"、"检查前置元数据"、"修复前置元数据"、"前置元数据审计"、"大脑 lint" | `skills/frontmatter-guard/SKILL.md` |
| "什么搜索模式"、"我的缓存是否热"、"调优我的检索"、"比较搜索模式"、"清除搜索覆盖" | 直接使用 `gbrain search modes/stats/tune`。请参阅 `skills/conventions/search-modes.md` |
| "评估结果"、"搜索基准"、"抗批评者方法"、"检索回归检查" | `gbrain eval run-all` / `gbrain eval compare`。请参阅 `docs/eval/SEARCH_MODE_METHODOLOGY.md` |

## 内容和媒体摄取

| 触发器 | 技能 |
|---------|-------|
| "捕获这个"、"保存这个想法"、"记住这个"、"放到收件箱中"、"保存到大脑" | `skills/capture/SKILL.md` |
| 用户分享链接、文章、推文或想法 | `skills/idea-ingest/SKILL.md` |
| "观看这个视频"、"处理这个 YouTube 链接"、"摄取这个 PDF"、"保存这个播客"、"处理这本书"、"总结这本书"、"PDF 书籍"、"摄取到我的脑海中"、"这个截图中是什么"、"看看这个仓库" | `skills/media-ingest/SKILL.md` |
| 收到会议记录 | `skills/meeting-ingestion/SKILL.md` |
| 通用"摄取这个"（自动路由到上述） | `skills/ingest/SKILL.md` |

## 思考技能（来自 GStack）

| 触发器 | 技能 |
|---------|-------|
| "头脑风暴"、"我有一个想法"、"办公时间" | GStack: office-hours |
| "审查这个计划"、"CEO 审查"、"找漏洞" | GStack: ceo-review |
| "调试"、"修复"、"损坏"、"调查" | GStack: investigate |
| "回顾"、"什么已发布"、"回顾会议" | GStack: retro |

> 这些技能来自 GStack。如果安装了 GStack，智能体会直接读取它们。
> 如果没有，仅大脑模式仍然有效（大脑技能在没有思考技能的情况下也能工作）。

## 操作类

| 触发器 | 技能 |
|---------|-------|
| 任务添加/删除/完成/推迟/审查 | `skills/daily-task-manager/SKILL.md` |
| 早晨准备、会议上下文、一天规划 | `skills/daily-task-prep/SKILL.md` |
| 每日简报、"今天发生什么" | `skills/briefing/SKILL.md` |
| Cron 调度、安静时间、作业交错 | `skills/cron-scheduler/SKILL.md` |
| 保存或加载报告 | `skills/reports/SKILL.md` |
| "创建一个技能"、"改进这个技能" | `skills/skill-creator/SKILL.md` |
| "技能化这个"、"这是一个技能吗？"、"使这个正确" | `skills/skillify/SKILL.md` |
| "压缩我的解析器"、"AGENTS.md 太大"、"RESOLVER.md 太大"、"功能区域调度器"、"缩小路由表" | `skills/functional-area-resolver/SKILL.md` |
| "gbrain 是否健康？"、早晨健康检查、技能包检查 | `skills/skillpack-check/SKILL.md` |
| "收获这个技能到 gbrain"、"发布这个技能到 gbrain"、"提升这个技能到上游"、"与其他 gbrain 客户端共享这个技能"、"提升我的技能到 gbrain" | `skills/skillpack-harvest/SKILL.md` |
| 重启后健康 + 自动修复、"容器重启是否破坏了任何东西"、冒烟测试 | `skills/smoke-test/SKILL.md` |
| 跨模态审查、第二意见 | `skills/cross-modal-review/SKILL.md` |
| "验证技能"、技能健康检查 | `skills/testing/SKILL.md` |
| Webhook 设置、外部事件处理 | `skills/webhook-transforms/SKILL.md` |
| "生成智能体"、"后台任务"、"并行任务"、"引导智能体"、"暂停/恢复智能体"、"gbrain jobs submit"、"提交一个 gbrain 作业"、"提交一个 shell 作业"、"shell 作业" | `skills/minion-orchestrator/SKILL.md` |
| "呈现选项"、"在继续前询问"、"选择网关"、"用户决策" | `skills/ask-user/SKILL.md` |

## 设置和迁移

| 触发器 | 技能 |
|---------|-------|
| "设置 GBrain"、首次启动 | `skills/setup/SKILL.md` |
| "现在做什么？"、"填充我的大脑"、"冷启动"、"引导"、"导入我的数据"、"我应该首先导入什么" | `skills/cold-start/SKILL.md` |
| "从 Obsidian/Notion/Logseq 迁移" | `skills/migrate/SKILL.md` |
| 大脑健康检查、维护运行 | `skills/maintain/SKILL.md` |
| "提取链接"、"构建链接图"、"填充时间线" | `skills/maintain/SKILL.md`（提取部分） |
| "运行梦想"、"处理今天的会话"、"综合我的对话"、"整合昨天的对话"、"你看到了什么模式"、"梦想周期是否运行" | `skills/maintain/SKILL.md`（梦想周期部分） |
| "大脑健康"、"我缺少什么功能"、"大脑评分" | 运行 `gbrain features --json` |
| "设置自动驾驶"、"运行大脑维护"、"保持大脑更新" | 运行 `gbrain autopilot --install --repo ~/brain` |
| 智能体身份、"我是谁"、自定义智能体 | `skills/soul-audit/SKILL.md` |
| "填充链接"、"提取链接"、"回填图" | `skills/maintain/SKILL.md`（图填充阶段） |
| "填充时间线"、"提取时间线条目" | `skills/maintain/SKILL.md`（图填充阶段） |

## 身份和访问（始终开启）

| 触发器 | 技能 |
|---------|-------|
| 非所有者发送消息 | 在响应前检查 `ACCESS_POLICY.md` |
| 智能体需要知道其身份/氛围 | 读取 `SOUL.md` |
| 智能体需要用户上下文 | 读取 `USER.md` |
| 操作节奏（何时检查什么） | 读取 `HEARTBEAT.md` |

## 消歧规则

当多个技能可能匹配时：
1. 优选最具体的技能（meeting-ingestion 优于 ingest）
2. 如果用户提到 URL，按内容类型路由（链接 → idea-ingest，视频 → media-ingest）
3. 如果用户提到人物/公司，检查丰富或查询是否更合适
4. 链式调用在每个技能的阶段部分中明确
5. 如有疑问，询问用户（请参阅 `skills/ask-user/SKILL.md` 了解选择网关模式）

## 约定（跨领域）

这些适用于所有大脑写入技能：
- `skills/conventions/quality.md` — 引用、反向链接、可记忆性网关
- `skills/conventions/brain-first.md` — 在外部 API 之前检查大脑
- `skills/conventions/brain-routing.md` — 目标哪个大脑（DB）和哪个源（仓库）；跨大脑联邦仅是潜在空间
- `skills/conventions/schema-evolution.md` — 何时添加类型 vs 别名 vs 前缀（在 `schema-author` 之前阅读）
- `skills/conventions/subagent-routing.md` — 何时使用 Minions vs 内联工作
- `skills/ask-user/SKILL.md` — 决策点的人工输入选择网关模式
- `skills/_brain-filing-rules.md` — 文件存放位置
- `skills/_output-rules.md` — 输出质量标准

## 未分类

| 触发器 | 技能 |
|---------|-------|
| "这本书的个性化版本"、"镜像这本书"、"双栏书籍分析"、"将这本书应用到我的生活"、"这本书对我有什么应用" | `skills/book-mirror/SKILL.md` |
| "丰富这篇文章"、"丰富大脑页面"、"批量丰富"、"使大脑页面有用" | `skills/article-enrichment/SKILL.md` |
| "战略阅读"、"通过这个镜头阅读"、"将这个应用到我的问题"、"我能从中学习什么"、"从这个中提取玩法" | `skills/strategic-reading/SKILL.md` |
| "概念综合"、"综合我的概念"、"在我的笔记中找到模式"、"构建我的智力地图"、"追踪想法演变" | `skills/concept-synthesis/SKILL.md` |
| "perplexity 研究"、"关于...的新内容"、"...的当前状态"、"网络研究"、"关于...有什么变化" | `skills/perplexity-research/SKILL.md` |
| "爬取我的归档"、"在我的归档中找到黄金"、"归档爬虫"、"扫描我的 dropbox 以查找"、"挖掘我的旧文件以查找" | `skills/archive-crawler/SKILL.md` |
| "验证这个学术声明"、"检查这项研究"、"学术验证"、"验证引用"、"这项研究是真的吗" | `skills/academic-verify/SKILL.md` |
| "从大脑制作 pdf"、"大脑 pdf"、"将大脑页面转换为 pdf"、"将这页发布为 pdf"、"导出大脑页面" | `skills/brain-pdf/SKILL.md` |
| "语音笔记"、"摄取这个语音备忘录"、"转录并归档"、"语音笔记摄取"、"保存这个音频笔记" | `skills/voice-note-ingest/SKILL.md` |
| "添加一个页面类型"、"向我的模式添加一个类型"、"模式作者"、"模式变异"、"模式包添加"、"我的大脑有未类型化的页面"、"从我的语料库提议新类型"、"回填页面类型"、"演化我的模式"、"研究员类型"、"使 X 成为专家类型"（调度器用于：gbrain schema active/list/show/validate/graph/lint/stats/explain/use/downgrade/reload/init/fork/edit/diff/add-type/remove-type/update-type/add-alias/remove-alias/add-prefix/remove-prefix/add-link-type/remove-link-type/set-extractable/set-expert-routing/detect/suggest/review-candidates/review-orphans/sync） | `skills/schema-author/SKILL.md` |
| "统一我的类型"、"迁移到 gbrain-base-v2"、"从 94 个类型到 14 个"、"应用规范分类法"、"清理我的页面类型"、"包升级"、"缩小类型扩散"、"整合页面类型"、"将页面重新类型化为规范"（调度器用于：gbrain onboard --check、gbrain onboard --check --explain、gbrain jobs submit unify-types、gbrain pages restore） | `skills/schema-unify/SKILL.md` |

## PMBrain 项目管理扩展

以下是 PMBrain 改造计划新增的项目管理相关技能路由：

| 触发器 | 技能 |
|---------|-------|
| "项目健康度"、"项目状态"、"项目进展"、"项目风险"、"项目报告" | `skills/pm-status/SKILL.md` |
| "项目任务"、"任务列表"、"任务分配"、"任务进度"、"项目待办" | `skills/pm-task/SKILL.md` |

## Uncategorized

| Trigger | Skill |
|---------|-------|
| "帮我扩写这段话" | `skills/yunhui-style-writer/SKILL.md` |

| "写一篇AI教程" | `skills/momo-ai-tutorial/SKILL.md` |
