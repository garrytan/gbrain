# 上游能力评估：Chronicle 与 SkillOpt

时间：2026-07-25  
上游基准：`D:\cursor-claude\gbrain` @ `3fafb69b077e602e1286af9cb092ed94455657a8`

## 结论

本轮完成评估，但不直接嫁接 Chronicle 和 SkillOpt。两者都属于 D 类：需要独立立项和底层架构确认。

## Chronicle

上游主提交 `64617904` 涉及 53 个文件、约 2758 行新增，包含：

- `life/events` 事件页、时间线投影和双时间本体；
- facts 表新字段、迁移、PGLite/Postgres 双引擎实现；
- 8 个以上 MCP/CLI 读取与管理操作；
- capture、advisor、doctor、search boost、后台 Worker；
- 远程日记隐私过滤与 Chronicle 专用评估集。

价值：适合个人长期记忆、人物关系和“某天发生了什么”类查询。  
风险：会改变 facts/ontology 数据模型、搜索排序、后台写入和隐私边界，不是可独立复制的小模块。

建议进入条件：

1. PMBrain 明确把“个人生命时间线”列为产品能力，而不只是项目知识库；
2. 先完成隐私分级、日记远程读取策略和事件页目录设计；
3. 单独设计 v113+ 迁移、回滚与老用户数据验证；
4. 先以默认关闭的只读 Chronicle 评估集验证，再开放自动抽取。

## SkillOpt

重新按上游 `3fafb69b` 检查后，SkillOpt 已从早期基础实现扩展为一套完整子系统：`src/core/skillopt/` 22 个文件、22 个专项测试文件，并接入 CLI、Dream、后台任务和管理员权限 MCP。

当前上游已经包含：

- 训练/选择/测试拆分、median-of-3 验证门、最终 test 与 held-out 双重评估；
- `--no-mutate` 的 `proposed.md`、版本历史、拒绝提案缓冲和原子写入；
- 每技能锁、运行时限、成本预估、单技能/全局预算与审计记录；
- benchmark 自动草拟、人工复核哨兵、真实使用样本捕获；
- 远程 `run_skillopt` 默认拒绝，需管理员 scope 和技能 allowlist；
- Dream 阶段默认关闭，且 bundled skill 的自动修改有额外 held-out 门槛。

价值：把 `SKILL.md` 当作可优化参数，使用 benchmark、训练/选择/测试拆分和 LLM judge 产生更优提案。  
风险仍然没有消失：它会修改技能文件，依赖高质量 benchmark、held-out 样本和可靠 judge；没有 PMBrain 自有验收集时仍可能“优化指标、损害实际使用”，并引入持续模型成本。完整嫁接还依赖上游 AI gateway 的多轮 tool loop、预算、后台任务、MCP 权限和 Dream phase，不适合拆出一个轻量文件直接复制。

建议进入条件：

1. 先为 PMBrain 自有技能建立人工审核的 benchmark；
2. 第一阶段只嫁接本地 CLI 的 `--no-mutate`，输出 `proposed.md`，不接 Dream、不接远程 MCP，禁止自动覆盖 `SKILL.md`；
3. 固定模型、提示词、数据拆分和成本上限；
4. 通过人工盲测后，再讨论版本存储、自动写入和 Dream 默认关闭阶段；
5. 在嫁接前先补齐 PMBrain AI gateway 的 tool-loop 消息兼容测试，避免只为 SkillOpt 引入与现有子 Agent 共用的回归。

## 本轮取舍

- Chronicle：暂缓，原因是数据模型、隐私和双引擎改动过大。
- SkillOpt：继续暂缓完整嫁接。上游安全门已明显成熟，但 PMBrain 仍缺专属 benchmark、held-out 样本和人工盲测门槛。可独立立项的最小第一步是“单技能、本地、`--no-mutate`、固定成本上限”的提案生成器。
- 已先采用低风险基础：搜索增强、Dream 稳定性、默认关闭的 drift/enrich_thin、只读 MCP 技能目录。
