# PMBrain 与原版 GBrain 的检索和 Dream 功能对比

维护日期：2026-10-08

## 当前关系专项：1.4.42

本轮按用户批准移植 GBrain `0.60.102.0` / `5b5891069413b28b2fe3a50675116d67d5a1e145` 的关系子系统。来源见 `.upstream/gbrain-subsystems.json` 与《上游能力来源台账》；下文旧版本是历史对照，不代表全项目已升级到本次关系基线。

| 链路 | 当前实现与边界 |
|---|---|
| 普通正文提及 | 原版 Pack-aware 策略与匹配器；concept/project 默认不参与，中文停用词在适配层 |
| 别名 | 原版 subject/declared 派生、长度/通用词/首词歧义/大小写过滤；显式 frontmatter 别名独立保留 |
| 增量补连 | 原版词表、页面修订状态和 generation；不变的第二轮 0 页，新增实体按上游候选匹配补扫 |
| 页面并发 | 原版 UUID 修订、Source incarnation、可恢复元数据迁移；旧知识正文不回改 |
| 显式链接 | 原版 Source-local 名称索引与派生关系对账，PMBrain 当前 Source → default；显式 Source 限定保留 |
| 后建目标 | wanted_links 保存未解析引用，目标出现后抽取来源页 |
| 导入识别实体 | 共享导入事务保存请求 → 成功后直接进入既有持久产品队列 → PMBrain 现有 capture Agent → GBrain 索引/NER/对账；启动/任务结束恢复待处理请求，沿用模型预算 |
| 老库升级 | PMBrain 独立版本键和迁移台账，旧 131/132/133 对照上游 150/206/214；先修复写放大，再按 100 页补修订，取消或进程退出后继续 |
| 中文检索写入成本 | 移除页面正文三字索引，保留标题、Slug、分块；全文仅内容相关列且值变化时计算，正文兜底每页一次，按页选择候选避免长文分块挤占 |
| 尚未移植 | managed canonical filesystem、完整写能力授权、时态关系有效区间、GBrain ingest Agent 替换、实体卡和待建页新 UI；覆盖报告辅助模块尚未产品接线 |

本轮完成隔离双引擎与模拟提供商验收，并在两份 3142 页真实备份副本上验证完整升级、中断/重启、13 张原有表的数据完整性和关系生命周期。六组中文查询读性能改善，但部分前 20 条重排，未做完整语义题集评测。历史页面支持 PGLite 只读分类报告，不自动改类型；真实库 44% 误关联和原第 770 页那次任务不作为已验证修复。准确 SHA CI、真实提供商和正式安装包尚未验收，成熟度保持 Beta。全项目对齐仍要逐子系统完成；旧全项目基线只作历史追溯，当前来源以 37 项映射清单为准。page-state-engine 与 derived-link-reconciliation 测试为现有接口子集，未移入 managed canonical filesystem、出勤证据门或时态边区间。

---

PMBrain 基线：Core **1.3.67**（本分支产品栈至 PR11 / 1.3.66，本文档 PR 递增至 1.3.67）。第 2–10 节仍是 2026-08-31 对 GBrain 0.47.7.0 的 RAG/Dream 复核，未整篇重写。

GBrain 吸收基线：`0.48.5.0`（本地树 `D:\cursor-claude\gbrain`）。历史 RAG/Dream 对照仍以当时 `master` commit `aa820c7f9934f3c23fbf67ff9f3ecd03831cf30f`、VERSION `0.47.7.0` 为准。`0.47.6.0 → 0.47.7.0` 仅变更测试基础设施、CI、基准与测试文件，没有新增 Core/Dream 运行行为。

**2026-09-19 产品决定：** Chronicle / `event_page_id` / `facts.dimension` / Connectors / Open Loops / Ontology / 实体身份 / Advisor chronicle / Memorable / BrainBench **已吸收，不再暂缓**。SkillOpt 与全局 basename Wikilink **明确不移植**。本分支实际代码见第 11 节，勿把 sibling PR 的文件算进本树。

> 两个项目采用不同版本规则，版本号不能直接比较大小。本对比以实际代码、阶段顺序、配置解析和测试入口为准，不以版本号推断能力。

## 1. 结论

PMBrain 不是重新实现了一套 RAG 和 Dream：

- RAG 的混合召回、搜索模式、排序增强、图谱召回、缓存、遥测和评测底座主要沿用 GBrain。
- Dream 的阶段顺序、锁、Source 作用域、知识抽取、概念合成、观点与校准等主流程主要沿用 GBrain。
- PMBrain 的新增集中在中文与项目管理检索、普通模型统一兜底、无默认 Embedding 安全契约、桌面与 Admin 产品化、Source 安全实体解析、知识关系回填、孤儿治理和面向真实用户的质量评分。
- PMBrain 仍有尚未同步的上游更新，不能把这些差异误称为产品创新。查询向量共享 deadline 已确认原本就存在，最新 Query cache 隔离与 Retrieval Reflex 已按当前产品能力对齐。Chronicle / 连接器 / 待我处理 / 本体 / 实体身份 / Advisor 年表采集已吸收。SkillOpt 与全局 basename Wikilink 仍不移植。Memorable 与 BrainBench 已作产品吸收，但代码在 sibling 分支，本树未合入。

后续维护原则仍是：

1. GBrain 负责核心知识运行时骨架。
2. PMBrain 优先移植不冲突的底层修复。
3. 中文、国产模型、Windows 桌面、Admin、Office 和项目管理交互留在 PMBrain 产品层。
4. 与 Source 安全规则、老用户数据兼容相冲突的上游能力不得直接覆盖。

## 2. RAG：沿用原版 GBrain 的能力

| 能力 | 来源判断 | PMBrain 当前状态 | 主要代码 |
|---|---|---|---|
| Vector、FTS、trigram 多路召回 | 沿用 GBrain | 保留，并继续作为混合检索候选集 | `src/core/search/hybrid.ts`、`vector.ts`、`keyword.ts` |
| RRF 融合、去重和结果预算 | 沿用 GBrain | 保留 | `hybrid.ts`、`dedup.ts`、`token-budget.ts` |
| conservative / balanced / tokenmax | 沿用 GBrain | 保留三种搜索模式及 per-call → config → bundle → balanced 解析链 | `src/core/search/mode.ts` |
| 多查询扩展 | 沿用 GBrain | 保留；tokenmax 默认启用，普通模式按配置使用 | `src/core/search/expansion.ts` |
| Query cache 与旋钮哈希 | 沿用 GBrain 后适配 | 已对齐文本守卫、请求姿态哈希、动态过滤绕过与 mode 返回量；PMBrain 额外隔离中文推断日期、精确 slug 排除和代码过滤 | `query-cache.ts`、`mode.ts`、`hybrid.ts` |
| 意图权重、时间、情绪、Source boost | 沿用 GBrain | 保留，并增加中文意图词 | `query-intent.ts`、`intent-weights.ts`、`source-boost.ts` |
| 标题短语、精确匹配与别名加权 | 沿用后适配 | 保留上游标题/别名逻辑；PMBrain 额外强化中文精确 slug 尾名 | `title-match.ts`、`alias-normalize.ts`、`intent-weights.ts` |
| Graph signals | 沿用 GBrain | balanced/tokenmax 保留图谱邻接、跨 Source hub 和会话多样性信号 | `graph-signals.ts` |
| Relational recall | 沿用 GBrain | 关系问题可从实体进入 typed-edge 图谱，多跳深度上限为 3 | `relational-intent.ts`、`relational-recall.ts` |
| Contextual retrieval | 沿用 GBrain | balanced 使用标题上下文，tokenmax 可使用分块概要 | `contextual-retrieval-resolver.ts`、`contextual-retrieval-service.ts` |
| 专用 Reranker 与 autocut | 沿用后调整默认值 | 能力保留；PMBrain 的 balanced 默认关闭，tokenmax 或高级配置可显式启用 | `rerank.ts`、`autocut.ts`、`mode.ts` |
| Adaptive return | 沿用 GBrain | 保留按结果质量调整返回量 | `return-policy.ts` |
| Cross-modal 搜索 | 沿用 GBrain | 保留文本、图片和双路 RRF | `by-image.ts`、`image-loader.ts`、`embedding-column.ts` |
| Explain、evidence、telemetry | 沿用后增强 | 保留上游得分归因；PMBrain 增加 vector/reranker 实际执行状态 | `explain-formatter.ts`、`evidence.ts`、`telemetry.ts` |
| qrels、eval gate、LongMemEval | 沿用后增强 | 保留上游评测入口，并扩展真实用户题集和评分字段 | `src/core/bench/`、`src/commands/eval-*` |

## 3. RAG：PMBrain 自己新增或产品化的能力

| 能力 | PMBrain 新增内容 | 原因 |
|---|---|---|
| 中文查询规范化 | 新增 `query-normalize-zh.ts`，处理 NFKC、中文相对时间、项目词同义表达和最多 4 个词法变体 | 原版主要面向英文个人知识场景 |
| 中文意图识别 | 为 temporal、event、entity、canonical、recency、salience 增加中文规则 | 让“近期进展”“谁负责”“现在怎么样”等进入正确排序路径 |
| 中文精确名称保护 | 完整 slug、slug 尾名或标题精确命中至少获得 1.25 倍加权 | 导入页标题可能泛化，但用户记得原文件名或中文名称 |
| 普通模型统一兜底 | `models.default` / `chat_model` 成为普通模型；高级模型失败后回退普通模型 | 发布版不能要求所有用户持有 Anthropic、OpenAI 或专用模型密钥 |
| balanced 无专用 Reranker 依赖 | balanced 默认关闭 Reranker 和依赖其分数的 autocut | DeepSeek 等普通模型加本地向量即可运行 |
| 检索链路状态回显 | `--explain` 标明 vector 与 reranker 是 applied、disabled 还是 failed | 禁止静默降级被误认为模型质量问题 |
| Source 作用域真实题集 | qrels 每题可指定 Source，相关页按 `source_id + slug` 判断 | 防止多知识源同名页被算作正确命中 |
| 完整排序指标 | 在上游 Recall/Top1 基础上增加 MRR、Precision、nDCG、逐题返回页和页面级去重 | 同一页多个 chunk 不能重复增加 Recall |
| 公开与私有双层评测 | 公开固定题集用于 CI；私人真实问题存放在忽略目录 | 同时约束所有用户的公共质量和个人真实措辞 |
| 中文质量规范与模型评分 | 固定预计回答、答案条件、引用准确率、Source 隔离和模型 A/B 规则 | 模型推荐必须来自同题集实测，而不是主观印象 |
| 无默认 Embedding | 新安装、普通模型 API Key 和 Dream 模型都不会自动选择向量供应商；必须显式配置模型和维度 | 防止未授权的云端调用、混合向量空间和错误模型标签 |
| 向量 provenance 一致性 | 只有非空向量才记录实际 `provider:model`；无向量分块为 `NULL`，no-embed 重写保留原向量标签 | 修复 Ollama 向量被错误标成 ZeroEntropy 的统计和冲突更新问题 |
| Keyword-only 明确降级 | 未配置 Embedding 时 vector 状态为 unavailable，关键词、标题和关系检索仍可工作 | 所有用户都能理解实际执行链路，不把未启用误认为模型效果差 |

## 4. Dream：沿用原版 GBrain 的能力

### GBrain 0.47.6.0 全阶段复核结论

本轮逐阶段检查 `synthesize → extract → extract_facts → extract_atoms → patterns → synthesize_concepts → takes → calibration → drift → enrich_thin → embed → orphans...`。原有主流程完整，确认并处理的 P0 只有三组：

| P0 真实行为差异 | 对齐结果 | 用户影响 |
|---|---|---|
| `extract_facts` 非原子替换及 fence 异常处理 | 删除旧 fence 事实与插入新事实进入同一事务；解析异常、代码块伪 fence、timeline sentinel 以下 fence 均保留旧事实；`cli:` 与过期审计事实不被重抽覆盖 | 模型输出或数据库写入失败时，不会先删掉历史事实；手工与审计证据保留 |
| `patterns` / `synthesize_concepts` Source 不完整 | 候选读取、产物页面、receipt、rollup 和证据关系统一使用当前 Source；原始证据仍保留自身 Source | 多知识源同名页和证据不再串库 |
| Dream 中止、deadline 与私有队列所有权 | 父任务 signal/deadline 贯穿模型请求、循环和子任务；私有队列增加 owner/token/lease，阶段结束只清自己的队列，启动时只回收可证明失主的旧队列 | 用户停止深度整理后正在运行的上游请求会终止；超时任务不再后台续跑，也不会误取消其他 Dream |

除以上 P0 外，没有发现需要重新实现 Dream 主流程的新增阶段。后续只对新的真实差异做小范围移植。

PMBrain 的 `ALL_PHASES` 与 GBrain 主序列基本一致。除 GBrain 的 `skillopt` 未进入 PMBrain 外，核心顺序仍是：

```text
lint → backlinks → sync → synthesize → extract → extract_facts
→ extract_atoms → resolve_symbol_edges → patterns → synthesize_concepts
→ recompute_emotional_weight → consolidate
→ propose_takes → grade_takes → calibration_profile → drift
→ conversation_facts_backfill → enrich_thin
→ embed → orphans → schema-suggest → purge
```

| 能力 | 来源判断 | PMBrain 当前状态 |
|---|---|---|
| 单一有序 Dream cycle | 沿用 GBrain | 继续以 `ALL_PHASES` 作为唯一执行顺序，未另建平行流水线 |
| Cycle lock、刷新、超时与 dry-run | 沿用 GBrain | 保留，写阶段统一进入锁保护 |
| Phase scope | 沿用 GBrain | 保留 source / global / mixed 分类 |
| Transcript synthesize | 沿用后适配 | 保留会话转知识页的核心逻辑，增加 PMBrain 路径与模型适配 |
| Synthesize verdict | 沿用后对齐 | 已升级为评分、内容类型、候选分段、实体、模型和 triage 版本；旧布尔缓存会重判，截断、拒答和格式错误不会永久缓存 |
| Link、timeline 与 facts 抽取 | 沿用后适配 | 保留上游抽取骨架；历史 stale 回填统一重扫 WikiLink、Markdown、frontmatter 与实体引用，并继续执行 PMBrain Source 解析规则 |
| CJK 人名和中文关系类型 | 最新上游能力移植 | 已支持中日韩名称及中文 founded / works_at / advises 等关系语义 |
| 正文日期推断 | 最新上游能力移植 | `--infer-dates` 只使用可信正文、frontmatter 或文件名日期，不用 `updated_at` 代替事件日期 |
| Atom 与 concept | 沿用后增强 | 保留原子抽取和概念合成；PMBrain 增加结构化证据关系 |
| Patterns | 沿用后增强 | 保留跨会话模式发现；PMBrain 增加反向证据写入 |
| Consolidate / takes / grade / calibration | 沿用 GBrain | 保留事实合并、候选观点、评价和校准画像 |
| Drift 与 enrich_thin | 沿用 GBrain | 保留且默认受配置门控制 |
| Conversation facts backfill | 沿用 GBrain | 保留，支持 conversation、meeting、slack、email |
| Embed、orphans、schema-suggest、purge | 沿用后适配 | 保留后段顺序；Dream embed 已将任务中止信号传入 provider 请求并关闭后台人类摘要输出，PMBrain 继续保留无向量配置时跳过、真实失败计数、孤儿分母和产品回显 |
| 全阶段中止与 deadline | 最新上游能力移植 | 父任务中止和绝对 deadline 贯穿模型请求、循环及内联子任务；中止后的部分阶段不会被误报为成功 |
| Dream 私有子任务队列生命周期 | 最新上游能力移植 | 以 owner/token/lease 标记阶段私有队列；正常或异常退出只清理本阶段队列，启动恢复只回收可证明失主的旧队列 |
| PGLite Dream 子任务执行 | 沿用后对齐 | 私有子任务在同进程串行排空，不再跳过 synthesize 和 patterns；PostgreSQL 保留受控并发 |
| Source 新鲜度与全局阶段 | 沿用后对齐 | 每个 Source 只运行确定性的 Source 阶段，混合/全局阶段由单独维护任务执行一次，避免多 Source 重复消耗模型 |
| extract-atoms-drain | 沿用后对齐 | 单锁、固定时间窗持续清理积压；无进展停止；供应商全失败让持久任务重试而不是显示成功 |

## 5. Dream：PMBrain 自己新增或产品化的能力

| 能力 | PMBrain 新增内容 | 主要位置 |
|---|---|---|
| quick / full / meeting 预设 | 在不改变 `ALL_PHASES` 顺序的前提下选择阶段子集；meeting 强制执行必要的 atom 阶段 | `src/commands/dream.ts` |
| 普通模型与阶段级高级模型 | 七个真实 Dream 阶段可单独覆盖模型；留空继承实际 tier，失败回退普通模型 | `cycle/model-routing.ts`、Desktop 高级模型设置 |
| 国产与 OpenAI-compatible 模型 | DeepSeek、MIMO、智谱、Ollama 等可走统一 Gateway；非 Anthropic subagent 使用 Gateway tool loop | `model-config.ts`、`ai/gateway.ts` |
| Filing rules 与允许路径 | Dream 输出路径来自个人知识归档规则或 active schema pack，避免任意目录写入 | `cycle/allowed-slug-prefixes.ts` |
| 独立 Dream 输出目录 | 支持配置输出根目录并为桌面打包环境创建目录 | `cycle/dream-output.ts` |
| 结构化证据关系 | concept、pattern 等产物除正文 Wikilink 外，还写入 `derives_from` 与反向 `evidence_of` | `synthesize-concepts.ts`、`patterns.ts` |
| Source 内实体优先 | 当前 Source 精确解析优先，只回退 `default` 共享实体；跨其他 Source 必须显式限定 | `link-extraction.ts`、两种数据库引擎 |
| 任意目录精确路径 Wikilink | 精确路径存在时可以解析，不依赖历史目录白名单 | `link-extraction.ts` |
| PMBrain 孤儿统计规则 | 排除 Youdao 原始镜像、originals、附件、输出页、维护页等不应入链页面 | `orphan-policy.ts` |
| 历史关系安全回填 | Quick Maintenance 直接从数据库重扫 stale 页面，补齐 WikiLink、Markdown、frontmatter 与实体引用；同 Source 精确解析优先，只回退 `default`，写批次失败时不推进水位，并返回缺失端点、跨 Source、未解析引用与剩余积压计数。手工数据回填仍要求先备份、后质检 | `extract-stale.ts`、`link-extraction.ts`、`cycle.ts`、`scripts/backup-links.ts`、`scripts/report-link-quality.ts` |
| Admin 与桌面 Dream 产品层 | 一键整理、定时运行、阶段摘要、成果明细、后台无窗口运行和高级模型配置 | `admin/`、`desktop/` |
| 面向发布的 Dream 评分 | 事实保真、证据有效、实体串联、孤儿改善、去重、Source 规则和行动价值分开评分 | `docs/eval/PMBrain检索与Dream质量评测规范.md` |
| 未配置向量时跳过 embed | Dream 返回 `embedding_not_configured` 的 skipped 阶段，不会选择 ZE，也不会把普通模型当向量模型 | `src/core/cycle.ts`、`src/core/embedding-dim-check.ts` |
| 深度整理两阶段筛选 | 便宜模型先输出可验证的结构化 triage map，昂贵综合阶段优先读取候选分段和实体；可配置阈值、并发与时间预算 | `cycle/structured-triage.ts`、`cycle/synthesize.ts` |
| Source 内链接候选清单 | 综合前用标题、名称、slug 尾名和关键词生成零 Embedding 候选；只在当前 Source 内提供人物、项目、公司和概念链接 | `cycle/link-manifest.ts` |
| 原子积压自动排空 | Autopilot 只为确有积压的 Source 提交受保护的排空任务；一次任务持有同一 Source cycle lock 并重复处理 bounded batch | `cycle/extract-atoms-drain.ts`、`autopilot-fanout.ts` |
| Dream 产物可检索 | atom、concept 统一走导入切块管线；无向量配置时仍写 `content_chunks` 并可关键词召回 | `extract-atoms.ts`、`synthesize-concepts.ts` |
| 会话输入适配 | 当前 PMBrain 与本地 GBrain 均为 19 个 built-in；补齐 ChatGPT 导出、Slack 块、AI 角色标题、Speaker A/B 等格式并保留普通文档保护 | `conversation-parser/builtins.ts` |

## 6. 当前尚未同步或明确暂缓的上游能力

这些项目不能算作 PMBrain 新增能力。2026-09-19 已撤销的暂缓（Chronicle、连接器、待我处理、本体、身份、Advisor 年表、Memorable、BrainBench）以第 11 节为准；本节历史表只改被推翻的行，其余 0.47.x 对齐记录保持原样。

### GBrain 0.47.6.0 P0 底层行为复核

| P0 真实行为差异 | PMBrain 1.3.15 处理 | 数据边界 |
|---|---|---|
| 同步删除仍会直接消失，exclude 未贯穿完整同步 | **已对齐**：删除、异常路径清理与完整同步对账统一写 72 小时软删除；重新导入清除墓碑；`sync.exclude` 与可重复 `--exclude` 同时生效 | 不主动硬删知识页；只有既有 purge 在 72 小时后清理过期墓碑 |
| `get_stats` / `get_health` / brain identity 未按 Source 授权隔离 | **已对齐**：两种引擎的计数、边度、孤立页与实体页分母按允许 Source 过滤，远程 Operation 传入授权范围 | 不改变页面内容，只修正可见统计口径 |
| backlinks 把无日期引用混入 Timeline | **已对齐**：统一写入 `## Referenced by`，并放在 Timeline 前；保留历史时间线顺序 | 仅影响后续显式 backlinks 写回，不批量覆盖 Wiki |
| Embedding 卡死、超模型输入和旧超大 chunk 无自愈 | **已对齐**：运行级 stall watchdog、API 活性时间、单 heartbeat 30 秒硬超时与请求取消、模型 token 上限、旧 chunk 安全拆分 | 只重写确认为超限且内容快照未变化的 chunk；保留 Source、模态与代码元数据 |
| Dream verdict 永久缓存 | **已对齐**（Schema 120）：默认 30 天 TTL，读时忽略过期项，Dream 周期做尽力清理 | 只迁移缓存元数据，不改知识正文、关系、事实或向量 |

### Advisor 0.47.5.0 逐项行为 diff

| GBrain Advisor 差异 | PMBrain 1.3.14 处理 | 判定依据 |
|---|---|---|
| Backup coverage | **已按 PMBrain 数据形态对齐**：对有内容的 PGLite 检查 verified cold backup 是否存在及是否超过 30 天；只读 manifest，不打开、恢复、清理或改写数据库，输出不含本机路径 | Work Desktop 已有经过恢复验证的 PGLite 备份体系；直接复用比复制 GBrain 的 bootstrap workspace 缓存更可靠 |
| MCP client fit | **已做 PMBrain 适配并补齐执行底座**：持续失败检查仍依据 `oauth_clients + mcp_request_log`，远程只给聚合数；Schema 121 已增加 client surface、server ceiling、`request_tools` 自助缩面和 `auth rescope-client` operator pin | 右缩工具面已有真实执行入口；usage-driven starter 集合自动再推导仍未移植，不生成伪建议 |
| Recommended bundled skills | **已对齐**：post-install 与 recurring Advisor 共用当前推荐集合，补入 `cold-start`；仅本地 workspace 检查，必须征得用户同意后才安装 | PMBrain 已有 bundled skill、安装 receipt 和 `skillpack install`，无需新架构或数据迁移 |
| Brain-resident pack nag | **已吸收**（PR9，本分支有 nag ledger） | `collect-uninstalled-brain-pack` + `skillpack/nag-state.ts`；无 ledger / 远程 MCP / 已装同版本 / 非 resident pack 都不出 finding |
| Chronicle conflicts | **已吸收**（PR7 数据面 + PR9 collector） | 依赖的 `event_page_id`、ontology conflict、`collect-chronicle` 已在本分支；`--apply` 仍拒绝 `chronicle-backfill` |
| Advisor 公共排序、单 collector 故障隔离、远程 workspace 过滤、历史与 apply 白名单 | **已对齐或 PMBrain 更严格** | 现有实现已覆盖；`--apply` 额外限制 `pmbrain` argv、dispatch allowlist 与 Source id |

### GBrain 0.47.7.0 P1 底层行为复核

| P1 真实行为差异 | PMBrain 1.3.16 处理 | 数据边界 |
|---|---|---|
| Provider-agnostic Embedding 生命周期 | **已对齐**：新增显式迁移计划、`--yes` 确认、inflight/completed receipt 与 stalled 状态；分块记录正文哈希，完整页面记录 `model:dimension` 签名；模型/维度切换同步失效 chunks、facts、takes 和 query cache | Schema 121 只增加可空派生字段，不扫描或回填历史向量；历史 `NULL` receipt 继续视为兼容，只有用户显式运行 `pmbrain migrate embeddings --to ... --yes` 才验证新模型并重嵌入，正文、分块与原始资料不删除 |
| Context Pack / Delta / compaction checkpoint | **已对齐当前运行时可用面**：按 Source/client/session 保存 standing entity、已确认 checkpoint 指针，以及 page `(updated_at, slug)` / fact `(created_at, id)` 两套独立 keyset 游标；同一时间戳超过单批上限时可连续排空、不漏尾部；MCP 提供 `context_pack`、`delta`、`checkpoint_context` | 只保存实体名、slug、标题和游标，不复制私有页面正文；读取失败 fail-open，不阻断对话 |
| Reasoning JSON、prompt-too-long 与 Dream oneshot | **已对齐**：facts/atoms/oneshot 共用最终 JSON 恢复；prompt-too-long 沿 provider wrapper `.cause` 链识别；oneshot 最多一次结构化生成、最多 3 页、slug suffix 校验、写入 ledger 恢复，任何写入前异常回退 agentic | 已提交写入后禁止再走非确定性 fallback；所有写入继续受 Source 与 allowed slug prefix 约束 |
| Chat usage 与自定义定价 | **已对齐**：`gateway.chat` 成功边界写无内容 usage ledger，Minion 归因到 `job:<name>`；`get_usage` 只返回聚合；`pricing.overrides` 为代理/自定义模型提供真实价格，未知价格在有预算上限时仍 fail-closed | 不保存 prompt、回答或知识正文；未知价格为 NULL，不伪造 0 成本 |
| MCP initialize、slug 与 OAuth tool surface | **已对齐**：initialize 明确 `put_page` 全量替换及“检索内容是数据”；同步 slug 支持点、下划线与 `_index`；7 个 Memory Verb 与 verbs/starter/full 同时过滤 tools/list 和 dispatch；`--surface` 高于 config；OAuth client 可在 server ceiling 内自助调整，`auth rescope-client` operator pin 不可覆盖 | 隐藏工具不能靠猜名字调用；权限 scope、localOnly 和 Source 边界继续生效 |
| PGLite 异常关闭后的 WAL/checkpoint 自愈 | **已按 GBrain 0.47.7.0 对齐**：`Aborted()`、RuntimeError 与 unreachable 只在持久化 PG17 PGLite 目录、独占锁和布局校验通过后进入修复；先原子保留整套 `pg_wal` 与 `pg_control`，重置后只重试一次，失败自动恢复，冷却与 lock-reap 隔离防止循环动盘 | 不扫描、不回填知识或向量；冷备仅在一次性恢复副本上运行同一修复校验，真实 Sidecar 首次打开再对源库执行有备份的受保护修复；PostgreSQL 路径不变 |

| 上游能力 | PMBrain 状态 | 建议 |
|---|---|---|
| Query embedding 共享 deadline | **已确认对齐**；PMBrain 原实现已有单一 `makeQueryEmbedDeadline()`，缓存查询与主搜索共用同一绝对截止时间 | 本轮补充回归契约，不重复实现已有能力；向量服务停滞时仍只消耗一个超时窗口并回退关键词检索 |
| Dream embed 的 AbortSignal 与 quiet 输出 | **已对齐** | Minions/任务中心的 cycle signal 会传入 stale/all/单页向量请求与写入；Dream 固定 `quiet: true`，仍保留结构化 PhaseResult、heartbeat 和 stderr 错误；普通 CLI 默认输出不变 |
| Dream 全阶段中止、deadline 与私有队列生命周期 | **已对齐**（Schema 117） | 取消和截止时间已贯穿阶段与子任务；owner/token/lease 只用于安全清理与恢复，不重建知识数据 |
| Query cache 最新隔离 | **已按当前 PMBrain 检索面完成对齐**；本地 GBrain 0.47.5.0 为 `KNOBS_HASH_VERSION=26`，PMBrain 独立 epoch 为 11，版本号不直接照搬 | hard excludes、detail、salience、recency 进入哈希；日期、类型、非零分页及 PMBrain 独有的中文推断日期、精确 slug 排除、代码过滤绕过缓存；候选增加 NFKC/字符 bigram 文本守卫，命中返回量与 mode 一致 |
| Provider-agnostic embedding migration 命令 | **已对齐（Schema 121）** | PMBrain 保留无默认 Embedding 与显式确认规则，迁移可计划、恢复和检查停滞，不直接清空正文或索引内容 |
| Global basename Wikilink 解析 | **明确不移植**跨目录 basename | 当前 Source-local → default 更符合多 Source 安全边界；本轮吸收未改变这条边界 |
| Life Chronicle / 事件页投影 / 本体维度 | **已吸收**（PR1/PR6/PR7，本分支有代码） | Schema 125 `event_page_id`、126 `facts.dimension`、Chronicle 抽取/时间线/日记脱敏、ops `chronicle_*` / `ontology_*`。`auto_chronicle` 默认关；`life/**` 不进 Dream `dream_synthesize_paths` |
| Chat Connectors / Google source / Open Loops | **已吸收**（PR3/PR4/PR5，本分支有代码） | `src/core/connectors/`、`src/core/google/`、`src/core/loops/`；凭证只活在 `~/.pmbrain`；无 Google 时不得说「已清零」 |
| 跨 Source 实体身份 | **已吸收**（PR2，本分支有代码） | 手工 link；身份键 `(source_id, slug)`；`entity_identity.union` 默认关 |
| Memorable | **已吸收（产品决定）**；**本分支无代码** | 实现在 sibling `execute-plan/dce9287a-pr-8-memorable-opt-in-integration`。本树无 `src/core/memorable`，也无 `integrations.memorable` 接线。不得把 `~/.gbrain` 当捷径 |
| BrainBench / LongMemEval 对齐 | **已吸收（产品决定）**；**本分支无 BrainBench 语料** | 实现在 sibling `execute-plan/dce9287a-pr-10-brainbench-and-longmemeval`。本树无 `src/eval/brainbench`、`evals/brainbench`、`eval-brainbench.ts`；`src/eval/longmemeval/` 仍是吸收前的 5 个文件 |
| Retrieval reflex | **已对齐**（Schema 118） | 保留 GBrain 0.47.5.0 的当前 turn/滚动窗口候选提取、标题/别名/姓氏/CJK 解析、最多 3 个 Source 内实体指针、1500ms 硬超时、失败静默和词法臂开关；PMBrain Context Engine 优先使用 host resolver，PGLite 经运行中的 stdio/HTTP Sidecar 本地 IPC，Postgres 使用缓存直连。只在指针真正交付后记录无原始对话文本的确定性遥测，90 天自动清理；Doctor 只读报告开关、心跳与当前可见路径。隔离评测入口仍为 `scripts/eval-ambient-recall-reference.ts`，真实引擎契约为 `test/retrieval-reflex-alignment.test.ts` 与 `test/e2e/retrieval-reflex-postgres.test.ts` |
| SkillOpt | **明确不移植** | 缺少专属 benchmark 前不允许自动改 Skill。本树无 `src/core/skillopt` |
| `extract --stale` 关系抽取水位 | **已移植并补强**（Schema 115） | `pages.links_extracted_at` + 升级后的 extractor 版本会让历史页面重新进入 stale；Quick Maintenance 默认包含 frontmatter，写入失败不推进水位；保留 Source-local → `default`，不采用跨目录 global basename |
| MEMORY_VERBS `entity` | **已移植** | 零模型实体卡片 |
| Fact remember/forget | **已移植** | 知识库可列出 facts 表 |
| MCP `list_skills` / `get_skill` 协议信封 | **已对齐** | 返回 `instructions` / `client_guidance`；本地 Sidecar 默认打开 `mcp.publish_skills`；Agent 先读 Skill 再搜知识。未移植 `list_brain_skillpack`、SkillOpt |

## 7. 当前对齐完成后的实际体验

1. 深度整理不再只得到“值得/不值得”布尔值。便宜模型先标出分数、内容类型、实体和原文片段，昂贵模型拿着这张地图整理，例行操作更少进入昂贵阶段，人物、项目和概念链接更容易接到既有知识页。
2. 模型输出被截断、拒答或 JSON 损坏时，本轮不会把错误结果写进永久缓存。下一轮仍可重新判断，不会长期出现“这份内容永远不再整理”的假阴性。
3. 原子提取每批仍受预算和批量上限保护，但后台会在固定窗口内继续处理下一批。积压清空即停止，连续无进展即停止，全部供应商请求失败则任务失败并进入重试，不再把剩余积压包装成成功。
4. PGLite 桌面用户可完成完整 Dream 阶段；多 Source 下全局综合不再为每个 Source 重复运行。atom 和 concept 即使没有 Embedding，也会切块并可通过关键词搜索。
5. Query cache 不再只凭“向量很近”判断同一个问题；无关中文问题即使落入相近 embedding 区域也不会串用缓存。带动态日期、类型、分页、精确排除或代码过滤的请求直接走真实检索，缓存命中与未命中的返回数量保持同一 mode 规则。
6. Retrieval Reflex 已接入 Context Engine：当前 turn 或最近窗口提到已知实体时，最多补充 3 个 Source 内指针，引导 Agent 按需调用 `get_page`，不会改写消息或自动展开整页正文。PGLite 通过当前 Sidecar 的单所有者 IPC 查询，Postgres 复用缓存直连；1500ms 超时或任何解析失败都静默放弃，不阻断用户对话。Doctor 可区分“已启用但尚未触发”“PGLite Sidecar 未运行”和最近 7 天已真实交付。

数据库兼容：Schema 116 只为 `dream_verdicts` 增加可空结构化字段；Schema 117 只为 `minion_jobs` 增加可空的私有队列 owner/token/lease 字段和索引；Schema 118 新增空的 `context_volunteer_events` 交付遥测表及索引；Schema 119 增加 PGLite 中文 trigram 候选索引；Schema 120 只为 `dream_verdicts` 增加 TTL；Schema 121 只增加 embedding 可空派生哈希/签名、OAuth surface、session context state 与 chat usage ledger，不扫描、不计算、不回填既有向量。历史 `NULL` receipt 按 GBrain 原版语义 grandfather，不算 stale；新 receipt 只在后续真实向量写入时自然产生。以上迁移均不清空知识数据，也不修改现有知识页、原始资料或向量；真正的模型切换和重嵌入仍必须由用户显式确认。

## 8. Embedding 差异结论

最新 GBrain 仍保留 `zeroentropyai:zembed-1` 运行时默认值，因此这一点不沿用。
GBrain 已把部分分块 provenance 从硬编码 ZE 改为 Gateway 当前模型，这个方向沿用，
但 PMBrain 进一步要求“没有实际向量就不写模型”。

PMBrain 本次新增并固定以下行为：

1. `config.json` 没有完整的 `embedding_model + embedding_dimensions` 时不调用任何向量服务。
2. DeepSeek、MIMO、智谱等普通模型/API Key 只影响 Chat 和推理，不自动启用 Embedding。
3. Ollama 或其他显式模型失败时保留原错误，不切换到 ZE 或其他供应商。
4. Fresh schema 不写 `embedding_model`；1280 只作为未配置时的向量列存储宽度。
5. 导入、Dream、后台补全和两种数据库引擎共享 provenance 规则。
6. 历史向量的派生 hash/signature 保持 `NULL` 并继续可用，不在升级时回填，也不因 `NULL` 自动进入 stale；后续真实重嵌入时自然写入。

## 9. 如何判断后续功能属于哪一层

满足以下任一条件，优先视为 GBrain 核心层：

- 改动 vector / FTS / RRF / cache / graph / Dream phase 的通用算法。
- 同时影响 CLI、MCP、Admin 和桌面端调用的底层数据语义。
- 改动 pages、chunks、links、facts、takes 等通用数据结构。

满足以下条件，适合留在 PMBrain 产品层：

- 中文项目管理措辞、国内模型和 Windows 本地运行。
- Admin、桌面端、小白配置和成果展示。
- Office、会议目录、Codex/Claude 会话目录等具体输入体验。
- 本机私有题集、中文发布文档和用户配置迁移。

每次拉取 GBrain 更新时应先对照第 6 节，按以下顺序处理：

1. 安全和正确性修复。
2. RAG/Dream 通用能力。
3. 与 PMBrain Source、普通模型和老用户数据规则的冲突检查。
4. 公开题集、私人真实题集和隔离 Dream 评测。
5. 最后才更新桌面与 Admin 产品入口。

## 10. 2026-08-25 同步规则补充对齐

本节仅补充同步能力的专项复核，不表示前述 RAG/Dream 全文已重新审计。专项基线为 PMBrain 1.3.5 与本地 GBrain `master` commit `9dadfb97`。

| 同步能力 | GBrain 专项证据 | PMBrain 1.3.5 处理 |
|---|---|---|
| working-tree 显式开关 | `--working-tree` 与 `sync.include_working_tree` | 对齐；Admin 产品化为“包含未提交内容”，默认关闭 |
| Source 作用域失败账本 | open / acknowledged / auto_skipped 状态与次数阈值 | 对齐；固定文件第三次同类失败自动跳过，健康检查继续展示 |
| 基础设施失败保护 | Git sentinel 与数据库/Embedding 错误不允许跳过 | 对齐并保持 fail-closed |
| 数据库 op checkpoint | 长任务使用独立 DB checkpoint，不等同于最终书签 | 对齐；按 Source、仓库、commit 和参数隔离，成功后才清理 |
| Full Sync 内容来源 | 当前 GBrain `performFullSync()` 仍把现场目录交给 `runImport()` | PMBrain 按本次产品规则补齐为 `git archive HEAD` 快照；这是相对专项基线的兼容性修复，不宣称原版已具备 |

最终不变量：默认增量与 Full Sync 都只读取 Git HEAD；未提交变化只提示。只有显式开启 working-tree 同步才读取现场目录；任何路径都不会自动执行 `git commit`。

## 11. 2026-09-19 撤销暂缓：本分支诚实清单

代码吸收记录不再等同于产品成熟。以下内容曾按设计件 `项目管理/GBrain能力吸收底层架构设计.md` 合入代码，但能否进入普通产品必须以 [`项目管理/GBrain能力成熟度台账.md`](../../项目管理/GBrain能力成熟度台账.md) 为准。只有「稳定」能力允许进入普通界面；SkillOpt 与全局 basename Wikilink **从未被吸收**。

当前分支已合入 PR1–PR12，含 Memorable（PR8）与 BrainBench（PR10）。SkillOpt 与全局 basename Wikilink 仍不移植。

| 能力 | 产品状态 | 本分支代码 |
|---|---|---|
| Schema `event_page_id` / ontology 列 / `entity_identities` / `open_loops` | 已吸收 | 有（PR1，Schema 125–128；后续 129–130） |
| 实体身份 + MCP `localOnly` 三闸 | 已吸收 | 有 `src/core/entity-identity.ts`、`src/core/ops/entity-identity.ts` |
| Chat Connectors（ChatGPT / Claude） | 已吸收 | 有 `src/core/connectors/`、`src/core/ops/connectors.ts` |
| Google source + 凭证保险库 | 已吸收 | 有 `src/core/google/`、`src/core/creds/` |
| Open Loops / 待我处理 | 已吸收 | 有 `src/core/loops/`、`src/core/ops/loops.ts` |
| Ontology（`facts.dimension` + 中文别名） | 已吸收 | 有，写在 `src/core/chronicle/ontology.ts` 与 `ops/chronicle.ts` |
| Life Chronicle / 日记脱敏 / `eval-chronicle` | 已吸收 | 有 `src/core/chronicle/`、`src/eval/chronicle/harness.ts` |
| Advisor chronicle / writeback / brain-pack nag | 已吸收 | 有 `src/core/advisor/collect-chronicle.ts` 等 |
| Admin / Desktop 自动化产品面 | 已吸收后重构 | 数据连接收入设置，待我处理收入工作台，Chronicle 改名时间线收入知识，实体身份只在需要人工判断时进入待我处理 |
| Memorable | 已吸收 | 有 `src/core/context/memorable-capture.ts`、`src/commands/doctor/checks/integrations-memorable.ts` |
| BrainBench + LongMemEval 对齐 | 已吸收 | 有 `src/commands/eval-brainbench.ts`、`evals/brainbench/`、扩容后的 `src/eval/longmemeval/` |
| SkillOpt | **不移植** | 无 `src/core/skillopt` |
| 全局 basename Wikilink | **不移植** | 解析仍是当前 Source → `default` |

用户向说明：

- [连接 ChatGPT / Claude](../guides/chat-connectors.md)
- [连接 Google](../guides/google-connect.md)
- [待我处理](../guides/open-loops.md)
- [时间线](../guides/chronicle.md)
- [Memorable](../guides/memorable.md)
