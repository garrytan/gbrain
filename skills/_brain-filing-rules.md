# Brain 归档规则 — 所有写入大脑的技能必须遵守

## 规则

内容的**主要主题**决定它放在哪里。不是格式、不是来源、不是正在运行的技能。

## 决策协议

1. 识别主要主题（一个人？公司？概念？政策问题？）
2. 归档到与主题匹配的目录中
3. 从相关目录交叉链接
4. 当有疑问时：你会搜索什么来再次找到这个页面？

## 常见错误归档模式 — 请勿执行这些操作

| 错误 | 正确 | 为什么 |
|-------|-------|-------|
| 主题分析 -> `sources/` | -> 适当的主题目录 | sources/ 仅用于原始数据 |
| 关于一个人的文章 -> `sources/` | -> `people/` | 主要主题是一个人 |
| 会议衍生的公司信息 -> 仅 `meetings/` | -> 同时更新 `companies/` | 实体传播是强制性的 |
| 关于一家公司的研究 -> `sources/` | -> `companies/` | 主要主题是一家公司 |
| 可重用的框架/论文 -> `sources/` | -> `concepts/` | 它是一种心智模型 |
| 关于政策的推文线程 -> `media/` | -> `civic/` 或 `concepts/` | media/ 用于内容操作 |

## 特许例外：合成输出是独特的

"按主要主题归档"规则适用于原始摄取。合成输出如果是独一无二的（针对单个来源和特定读者定制的）（个性化书籍镜像、与一个问题绑定的战略阅读手册）不能干净地放入任何主题目录：按主题归档会丢失"这是书籍"维度；按作者归档会将作者页面与合成页面混淆。

`media/<format>/<slug>` 下的格式前缀路径是特许例外：

- `media/books/<slug>-personalized.md`（书籍镜像输出）
- `media/articles/<slug>-personalized.md`（长篇文章个性化）

如果你发现自己想要 `media/<format>/` 用于原始摄取，那仍然是上表中的反模式。例外很窄：合成的、独一无二的、对单个来源独特的。

## `sources/` 实际用于什么

`sources/` 仅用于：
- 批量数据导入（API 转储、CSV 导出、快照）
- 馈送多个大脑页面的原始数据（例如，客人导出、联系人同步）
- 定期捕获（季度快照、同步导出）

如果内容具有明确的主要主题（一个人、公司、概念、政策问题），它**不**进入 sources/。 period。

## 显著性门控

不是所有东西都值得拥有大脑页面。在创建新的实体页面之前：
- **人员：** 你会再次与他们互动吗？他们与你的工作相关吗？
- **公司：** 他们与你的工作或兴趣相关吗？
- **概念：** 这是一个值得以后参考的可重用心智模型吗？
- **当有疑问时，不要创建。** 缺失的页面可以稍后创建。垃圾页面浪费注意力并降低搜索质量。

## 铁律：反向链接（强制性的）

每次提及具有大脑页面的人或公司都必须从该实体的页面**创建反向链接**到提及他们的页面。这是双向的：新页面链接到实体，并且实体的页面链接回来。

反向链接格式（附加到时间线或另请参阅）：
```
- **YYYY-MM-DD** | 在 [页面标题](path/to/page.md) 中引用 -- 简要上下文
```

未链接的提及是破碎的大脑。图谱就是智能。

## 引用要求（强制性的）

写入大脑页面的每个事实都必须带有内联 `[Source: ...]` 引用。

三种格式：
- **直接归属：** `[Source: User, {context}, YYYY-MM-DD]`
- **API/外部：** `[Source: {provider}, YYYY-MM-DD]` 或 `[Source: {publication}, {URL}]`
- **合成：** `[Source: compiled from {list of sources}]`

来源优先级（从高到低）：
1. 用户的直接陈述（最高权威）
2. 编译真相（预先存在的大脑合成）
3. 时间线条目（原始证据）
4. 外部来源（API 丰富、网络搜索 -- 最低）

当来源冲突时，用两个引用注明矛盾。不要静默选择一个。

## 原始来源保存

每个摄取的项目都应保存其原始来源以用于溯源。

**大小路由（通过 `gbrain files upload-raw` 自动）：**
- **< 100 MB 文本/PDF**：保留在大脑仓库中（git 跟踪）在大脑页面旁边的 `.raw/` 并行目录中
- **>= 100 MB 或媒体文件**（视频、音频、图像）：上传到云存储（Supabase Storage、S3 等），并在大脑仓库中留下 `.redirect.yaml` 指针。文件 >= 100 MB 使用 TUS 可恢复上传（6 MB 块，带重试）以确保可靠性。

**上传命令：**
```bash
gbrain files upload-raw <file> --page <page-slug> --type <type>
```
返回 JSON：小文件为 `{storage: "git"}`，云为 `{storage: "supabase", storagePath, reference}`。

**`.redirect.yaml` 指针格式：**
```yaml
target: supabase://brain-files/page-slug/filename.mp4
bucket: brain-files
storage_path: page-slug/filename.mp4
size: 524288000
size_human: 500 MB
hash: sha256:abc123...
mime: video/mp4
uploaded: 2026-04-11T...
type: transcript
```

**访问存储的文件：**
```bash
gbrain files signed-url <storage-path>    # 生成 1 小时签名 URL
gbrain files restore <dir>                # 下载回本地
```

这确保任何派生的大脑页面都可以追溯回其原始来源，并且大文件不会使 git 仓库膨胀。

## 梦境循环合成 / 模式目录 (v0.23)

`gbrain dream` 的 `synthesize` 和 `patterns` 阶段写入从 `_brain-filing-rules.json` 的 `dream_synthesize_paths.globs` 数组获取的**固定允许列表**。编辑该 JSON 是合成子代理可以写入新目录的**唯一方法**：

| 输出类型 | Slug 模式 | 这里放什么 |
|-------------|--------------|----------------|
| 反思 | `wiki/personal/reflections/YYYY-MM-DD-<topic>-<hash[:6]>` | 自我知识、情感处理、模式识别。来自用户的逐字引用，带有分析。 |
| 会议纪要 | `wiki/meetings/YYYY-MM-DD-<meeting-topic>-<hash[:6]>` | 显式会议记录输入的逐场会议整理，包含目的、参会人、决策、行动项、开放问题和风险。 |
| 会话整理 | `wiki/conversations/YYYY-MM-DD-<conversation-topic>-<hash[:6]>` | 显式 AI/Codex/ChatGPT/Claude 会话输入的逐场会话整理，保留上下文、意图、决策、输出、待办和可复用经验。 |
| 原始想法 | `wiki/originals/ideas/YYYY-MM-DD-<idea>-<hash[:6]>` | 新框架、论文、心智模型、"概念主义 ideologist" 输出。捕获用户的确切措辞 — 这就是工件。 |
| 人员丰富 | `wiki/people/<existing-slug>` | 从会话提及附加到现有人员页面时间线条目。新实质性人员的存根页面。 |
| 模式 | `wiki/personal/patterns/<theme>` | 在 ≥3 个反思中检测到的跨会话主题。最高杠杆输出：如果反思引用 dated 内容，模式可以跨越 25 年。 |
| 循环摘要 | `dream-cycle-summaries/YYYY-MM-DD` | 一个梦境循环产生的每个页面的索引。由编排器确定性地自动写入。 |

**合成输出的铁律：**
1. 逐字引用用户。不要解释 memorable 的措辞。
2. 强制交叉引用：每个新页面必须链接到现有大脑内容。
3. Slug 纪律：仅小写字母数字和连字符，斜杠分隔。无下划线，无文件扩展名。
4. 编辑的转录本产生新的 slug（内容哈希后缀更改）— 永远不会静默覆盖先前的反思。

## Takes 归属 (v0.32+)

在写入 `<!--- gbrain:takes:begin -->` 围栏时，**holder** 列说明**谁相信**主张，而不是**关于谁**。超过 100K 生产 takes 的跨模态评估将归属评为 6.5/10 — holder/subject 混淆是 #1 错误。这六个规则是契约。带有工作示例的长格式位于 `docs/takes-vs-facts.md`。

1. **Holder ≠ subject。** 测试：这个人是否**说**或**清楚地暗示**这个？
   - 是 → `holder = people/<slug>`
   - 否，这是你对他们的分析 → `holder = brain`
   - 示例："Garry 有英雄/救援者模式" → `holder=brain`（关于 Garry 的分析，不是 BY Garry 陈述）
2. **原子主张。** 将复合行拆分为单独的行。每行一个主张。
3. **放大 ≠ 认可。** 仅转推信号上限为 `weight 0.55`。用户共享了某些东西；他们不一定认可每个条款。
4. **自我报告 ≠ 已验证。** "Saif 报告 7 位数" → `holder=people/saif`，`weight=0.75`，不是 `holder=world/1.0`。自我报告是一个强烈的个人信号，不是共识事实。
5. **无虚假精度。** 仅使用 0.05 增量（`0.35`、`0.55`、`0.75`）。`0.74` 和 `0.82` 意味着不存在的校准精度。引擎层在插入时四舍五入 — 在你的围栏中匹配网格并避免警告。
6. **"那又怎样"测试。** 跳过元数据风格的琐事（Twitter 句柄、关注者计数、明显的 bio 字段）。take 必须对某些未来查询具有承载性。

**Holder 格式（在 v0.32 中作为解析器警告强制执行，v0.33+ 中作为错误）：**
- `world`（共识事实，无个人索赔人）
- `brain`（AI 推断，holder 真正模糊）
- `people/<slug>`（个人陈述的信念）
- `companies/<slug>`（机构事实，无个人索赔人）

Slug 使用标准语法（`[a-z0-9._-]+`）。`Garry`、`people/Garry-Tan` 和 `world/garry-tan` 都失败验证。

**创始人描述自己公司的规则。** 当创始人描述他们自己的公司时，holder 是**创始人**，而不是公司。"我们可以达到 $10M ARR" 由 Bo Lu 说 → `holder=people/bo-lu`，不是 `holder=companies/clipboard-health`。公司不说话；他们的员工说话。
