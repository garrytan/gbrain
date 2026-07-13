# Bug 修复台账

## 2026-07-13 Admin 与桌面端主题统一及深色对比度补全

- 时间：2026-07-13
- 版本号：PMBrain 1.1.6
- 标题：统一桌面端、浏览器与 Admin 主题来源并补全深色模式可读性
- 描述：Admin 的独立浏览器主题会与桌面端设置冲突；深色模式下 MCP 配置代码块、Dream 推荐提示、知识库统计数字及一批灰色辅助文字对比度不足。
- 根因：桌面端和 Admin 分别维护主题偏好，缺少单一产品级来源；Dream 与通用 pre、提示状态组件仍保留浅色主题硬编码颜色。
- 解决方案：以桌面端持久化的主题设置作为 PMBrain 唯一产品级来源，system 模式交由浏览器/系统解析；Admin 在打开及重新获得焦点时同步桌面设置，不再使用 Cookie 或 localStorage 覆盖；补齐代码块、Dream、提示与状态组件的深色高对比度样式。
- 是否完成：是
- 最终结果：桌面端主题设置继续持久保存在 PMBrain 配置中；Admin 在打开和重新获得焦点时同步该设置，system 模式由浏览器/电脑主题解析。MCP 配置代码块、Dream 推荐标题与说明、知识库统计数字和通用提示状态均已补齐深色高对比度样式。Admin 9 项定向测试、桌面端 13 项主题相关测试、TypeScript 类型检查和生产构建通过，开发服务 3132 已完成浏览器逐项验证。

## 2026-07-13 Admin 主题持久化与深色模式可读性修复

- 时间：2026-07-13
- 版本号：PMBrain 1.1.5
- 标题：修复 Admin 主题重启后回退及深色模式局部浅色、低对比度问题
- 描述：用户固定浅色或深色后，部分浏览器会话重建时可能回退到跟随系统；MCP Tunnel 权限卡、Source 范围选择器和相关弹窗在深色模式下仍使用硬编码浅色背景与文字，影响可读性。
- 根因：主题偏好仅依赖 localStorage，缺少持久化冗余；深色模式采用增量覆盖，部分旧组件的硬编码浅色值未接入全局颜色变量。
- 解决方案：主题偏好同时写入 localStorage 与一年期同源 Cookie，并优先恢复有效的本地选择；补齐 Tunnel、Source 范围选择器、Agent Source 卡片的深色背景、边框、文字、选中态和状态色覆盖。
- 是否完成：是
- 最终结果：主题选择在刷新后仍保持；MCP Tunnel 权限卡、诊断信息与 API Key Source 范围弹窗已在深色模式下统一为深色背景和高对比度文字。Admin 定向测试 8 项、TypeScript 类型检查及生产构建均通过，开发服务已在 3132 端口启动并完成浏览器验证。

## 2026-07-12 Postgres 中文搜索超时修复

- 时间：2026-07-12 09:39:20
- 版本号：PMBrain 1.1.1
- 标题：修复更新后中文搜索触发 statement timeout 的问题
- 描述：PMBrain 1.0.81 的中文搜索增强新增 `_searchKeywordCJK()`，对正文执行 `ILIKE '%关键词%'`，绕过 GIN 索引并在 21421 个切片上顺序扫描；单字查询“水”在 8 秒限制内无法完成。原版 GBrain 没有该 Postgres 分支。
- 是否完成：是
- 最终结果：Postgres 中文查询恢复使用现有 `search_vector` GIN 索引；同库 SQL 实测命中 6 条、执行约 18ms。未修改知识库数据、Docker 配置或索引结构；PGLite CJK fallback 保持原行为。

## 2026-07-12 Admin 搜索无结果诊断与超时状态纠正

- 时间：2026-07-12 07:00:26
- 版本号：PMBrain 1.0.98
- 标题：区分数据库检索超时与知识库确实没有结果
- 描述：Admin 最近多次搜索虽然进程以 exit code 0 完成，但 stderr 均包含 Postgres `statement timeout`，混合检索返回 0 页面、0 观点，界面仍显示“已完成”和模型的“知识库没有信息”，让用户误以为搜索按钮无效或库内没有数据。本次在 Admin 结果区识别该原生错误，显示“检索超时”状态和明确说明，不再把超时伪装成空结果。
- 是否完成：部分完成
- 最终结果：概览确认数据库现有 4231 个页面、21420 个搜索切片且向量覆盖率为 100%；Admin 请求、运行创建、轮询和 JSON 解析均正常。真实故障已进一步用 `pmbrain search "订单现状" --limit 5` 复现，约 8.9 秒后由共享 Postgres 搜索层取消，因此模型实际收到 0 条资料。界面误导已修复；核心搜索超时或索引性能尚未修改，因为该层由 CLI、GUI、MCP 共用，按项目约束需用户确认后另行处理。

## 2026-07-11 Dream 运行结果恢复与完成状态一致性修复

- 时间：2026-07-11
- 版本号：PMBrain 1.0.96
- 标题：修复 Dream 返回页面后摘要、产出、进度和日志不属于同一运行结果的问题
- 描述：Dream 完成后，摘要逻辑会扫描整段日志中的 `locked` 字样，导致一份包含完整阶段报告的成功运行被误判成“锁正在保护另一轮运行”；同时产出摘要只统计 synthesize 写入，遗漏 patterns、同步、知识判断和搜索索引等真实产出，知识生长轨迹也会因 warn/skipped 阶段留下未打勾节点。本次改为只依据同一 run id 的结构化 `report.reason` 判断锁阻止，所有摘要、产出、阶段表和原始日志继续使用同一运行对象；汇总完整产出，成功完成并更新搜索索引的多阶段流程统一显示五项完成；阶段说明改为中文；一键/会议整理在需要 Subagent 时自动启动已有 Worker；删除概览页重复且无明显作用的“开始整理”按钮。
- 是否完成：是
- 最终结果：已补充运行恢复误判、完整产出、五项完成、中文说明、Worker 自动启动和无效按钮回归测试；Admin 类型检查、生产构建以及刷新/离开再返回页面的浏览器验证通过。

## 2026-07-10 模型名输入框自绘弹层替换原生 datalist + catalog 校正

- 时间：2026-07-10 11:43:00
- 版本号：Desktop 1.0.52
- 标题：修复厂商内模型切换只显示一个的 bug，替换原生 datalist 为自绘全量弹层
- 描述：切换厂商后原生 datalist 按输入框预填值做前缀过滤，点开只显示一个模型。改为移除 datalist + `list` 属性，⌄ 按钮打开自绘 `<ul>` 弹层，始终显示该厂商全部模型，不过滤、框内有值也不影响。同时校正 `model-catalog.ts`：mimo chat 去掉了误挂的 gpt 模型、新增 mimo-v2.5；zhipu 更新到 glm-5.2 代际；deepseek 去掉已弃用的 deepseek-chat；openai 补到 gpt-5.6-sol/terra/luna；google 更新到 gemini-2.5/3；移除 groq、together 厂商；embedding 移除 mimo 和 deepseek 厂商（无官方 embedding）、google 去掉 text-embedding-004。embedding 厂商下拉同步移除 mimo、deepseek 选项。
- 是否完成：是
- 最终结果：桌面端 typecheck + 前端构建 + 本地 3131/3132 服务正常；桌面版本更新为 1.0.52。



- 时间：2026-07-06 10:10:56
- 版本号：1.0.72；桌面端版本号：1.0.41
- 标题：修复桌面端 Workbuddy MCP 配置写入到错误文件的问题
- 描述：桌面端 MCP 接入将 Workbuddy 配置写入 `C:\Users\zhengyunhui\.workbuddy\.mcp.json`，但 Workbuddy 实际读取 `C:\Users\zhengyunhui\.workbuddy\mcp.json`，导致界面显示已写入而客户端配置仍为空。
- 是否完成：是
- 最终结果：已将桌面端 Workbuddy 自动写入路径改为 `C:\Users\zhengyunhui\.workbuddy\mcp.json`，补充路径回归测试；本机空 `mcp.json` 已备份并恢复为包含 `connector-proxy` 与 `pmbrain` 的有效配置；桌面端测试、类型检查、打包和打包后 sidecar 健康检查均通过。

## 2026-07-02 Dream 默认模型同步修复完成补记

- 时间：2026-07-02 09:50:00
- 版本号：1.0.63；桌面端版本号：1.0.37
- 标题：修复桌面端只配置 chat 模型时 Dream 仍需单独配置模型的问题
- 描述：补记本次完成状态，避免旧编码条目显示异常时无法确认结果。
- 是否完成：是
- 最终结果：桌面端配置保存和版本迁移路径都会将当前 chat 模型同步到 DB config 的 `models.default`；已验证 `dream --phase propose_takes --dry-run --json` 返回 clean。

## 2026-07-02 桌面端 Dream 默认模型同步修复

- 时间：2026-07-02 09:40:00
- 版本号：1.0.63；桌面端版本号：1.0.37
- 标题：修复桌面端只配置 chat 模型时 Dream 仍需单独配置模型的问题
- 描述：桌面端保存 AI 配置时已将 chat 模型同步为 `models.default`，并在迁移完成后写入数据库 config 表，确保 dream 的 `models.dream.*` 解析链默认复用 chat 模型。
- 是否完成：处理中
- 最终结果：待测试和打包验证后更新。

## 2026-07-01 Admin Dream 阶段执行卡住与诊断控制修复

- 时间：2026-07-01 15:50:11
- 版本号：1.0.61
- 标题：修复 Admin Dream synthesize 长时间 running、锁过期不可见和 Worker 队列不可控问题
- 描述：Admin 阶段执行页面启动 Dream synthesize 后，子任务进入 minions subagent 队列但 Worker 未运行或旧任务重放失败时，页面只显示 running，无法区分是 cycle lock、Worker 还是子任务队列问题；同时 synthesize 等待子任务期间没有持续刷新 cycle lock，5 分钟 TTL 可能过期；数据库驱动返回字符串化 content_blocks 时，gateway 重放会把工具调用历史当作普通字符串，触发 ModelMessage schema 错误；页面的超时分钟输入未传给后端，实际仍按默认 10 分钟超时。
- 是否完成：是
- 最终结果：subagent 历史消息读取时会先解析字符串化 JSON content_blocks，再适配为 gateway ChatBlock；waitForCompletion 增加 onPoll 钩子，synthesize 等待子任务时持续执行 yieldDuringPhase 以刷新 cycle lock；Admin Dream 概览返回 supervisor、subagent 队列和 stalled active 诊断数据，阶段执行页面显示运行诊断，并提供启动/停止 Worker、解除 cycle lock、取消非终态 job 的控制入口；启动 Dream 时会把超时分钟转换为 timeoutMs 传给后端；补充 waitForCompletion 续锁钩子和 subagent content_blocks 字符串化回放回归测试；PMBrain 版本更新为 1.0.61。

## 2026-06-30 Dream 运行结果可解释性与中止能力修复

- 时间：2026-06-30 16:05:00
- 版本号：1.0.57
- 标题：修复 Dream 运行完成后缺少自然语言结果、无法中止、切页后状态丢失和失败子任务复用问题
- 描述：Admin 阶段执行页只展示原始 stdout/stderr，用户难以判断 dry-run、locked、completed、failed 分别代表什么，也看不到是否生成知识点；运行中没有中止入口；切换页面后当前 run 状态不保留；Dream synthesize 的固定 idempotency key 会复用历史 failed/dead/cancelled 子任务，导致手动重跑同一输入仍然没有新知识页；DeepSeek/MIMO 等非 Claude 模型未读取 recipe 上下文窗口，可能使用过大的 fallback 切块预算。
- 是否完成：是
- 最终结果：Admin Dream run 改为读取 JSON 报告并生成"做了什么/产出结果/明细"自然语言摘要，原始日志收进折叠区；新增运行中"中止"按钮和 `/admin/api/runs/:id/cancel`，可结束 Admin 启动的子进程树并显示 cancelled 总结；前端用 localStorage 保留最近 run，切页回来继续轮询，浏览器刷新/关闭时提示；synthesize 对 failed/dead/cancelled 的历史子任务生成 retry idempotency key，成功任务仍保持幂等；cycle lock 遇到同主机已死亡 PID 时会自动清理后重试获取，避免死进程残留锁继续阻塞；模型上下文预算改为优先读取 recipe `max_context_tokens`，MIMO 标记为支持 subagent loop，DeepSeek 可按工具调用路径运行。PMBrain 版本更新为 1.0.57。

## 2026-06-30 Dream MIMO Gateway 工具调用执行失败修复

- 时间：2026-06-30 15:20:00
- 版本号：1.0.56
- 标题：修复 Dream 使用 MIMO 执行 subagent 工具调用时卡住或 dead-letter 的问题
- 描述：Dream synthesize 阶段使用 `mimo:mimo-v2.5-pro` 时，subagent worker 需要走 gateway-native loop；同时 AI SDK v6 对工具 schema、消息角色和工具结果消息有更严格校验，旧 gateway 适配会导致 `schema is not a function`、`ModelMessage[] schema`、`Tool results are missing` 等错误，进而让 Admin 页面长期显示 running。
- 是否完成：是
- 最终结果：启用 `agent.use_gateway_loop=true`，修复 gateway 工具 JSON Schema 包装方式；将 tool-result 消息转换为 AI SDK v6 需要的 `tool` 消息；为 gateway loop 增加工具结果回合落库，避免 retry 历史断链；重启 jobs worker 后，重新执行同一 Dream 输入，`cycle.synthesize` 可正常完成。PMBrain 版本更新为 1.0.56。

## 2026-06-29 Admin Vite 调试代理返回 HTML 修复

- 时间：2026-06-29 18:10:00
- 版本号：1.0.53
- 标题：修复 Admin 调试页 API 请求返回 Vite HTML 导致 JSON 解析失败
- 描述：Admin Vite 调试服务使用 `base: /admin/` 时，`/admin/api` 代理规则未命中，Import 页面读取 PMBrain 状态时拿到 Vite 的 `index.html`，前端按 JSON 解析后报 `Unexpected token '<'`。
- 是否完成：是
- 最终结果：`admin/vite.config.ts` 的代理规则改为正则 `^/admin/(api|auth|events|login)`，确认 `http://127.0.0.1:5173/admin/api/brain/overview` 返回后端 JSON 401 而不是 HTML；版本号更新为 1.0.53。

## 2026-06-29 Heavy tests 缺少 embedding provider 失败修复

- 时间：2026-06-29 17:35:00
- 版本号：1.0.50
- 标题：修复 frontmatter wallclock heavy test 在无 embedding provider 环境失败
- 描述：Heavy tests 中 `frontmatter_scan_wallclock.sh` 在隔离 HOME 下执行 `gbrain init --pglite --yes`，但当前 init 逻辑要求显式 embedding provider 或 `--no-embedding`，导致 GitHub Actions 在未配置模型 Key 时失败。
- 是否完成：是
- 最终结果：测试脚本改为 `init --pglite --no-embedding --yes`，该测试只验证 doctor frontmatter 扫描性能，不依赖向量化能力；同时将 source 注册步骤从 `bun run -e` 改为 `bun -e`，确保内联脚本在当前 Bun 中真实执行；版本号更新为 1.0.50。

## 2026-06-29 Admin Dream 启动与输入控制修复

- 时间：2026-06-29 15:13:00
- 版本号：1.0.49
- 标题：修复 Admin 选择"整轮 cycle"时未执行以及 propose_takes 不支持 --input 时仍显示输入框的问题
- 描述：Admin 页面 Phase 下拉选择"整轮 cycle"（value="all"）时，`buildDreamCommand` 中 `"all"` 被转为 `undefined` 导致 CLI 命令缺少 `--phase` 参数，整轮未执行；此外 `propose_takes`、`grade_takes`、`calibration` 等 phase 不支持 `--input`，但前端仍显示 Input file 输入框，用户填入文件路径后不生效。
- 是否完成：是
- 最终结果：`buildDreamCommand` 中 `"all"` 改为正确转为 `"cycle"`，整轮 cycle 可正常启动；Admin 页面中，当选择的 phase 不支持 `--input` 时，Input file 输入框自动禁用并显示提示文字"仅 synthesize 支持单文件，已禁用"，避免用户误填。PMBrain 版本更新为 1.0.49。

## 2026-06-29 Admin Console 自然语言任务交互与首页占位修复

- 时间：2026-06-29 11:40:00
- 版本号：1.0.47
- 标题：修复自然语言任务按钮状态、执行结果摘要和首页占位过高
- 描述：自然语言任务页的"发送"和"确认并执行"按钮点击后缺少已点击状态；确认执行期间仍可能重复触发；失败结果直接展示长日志，难以判断完成、跳过和失败情况；知识库总览首页复用自然语言任务卡片，占用首屏空间过多。
- 是否完成：是
- 最终结果：发送按钮和确认执行按钮点击后显示浅色已点击态；执行中确认按钮禁用，执行完成后恢复可点击并保留浅色状态；失败或导入结果会汇总文件总数、已导入、跳过、错误、完成阶段和主要问题，原始日志仍保留在详情中；知识库总览首页移除自然语言任务快捷卡并压缩 hero 高度。PMBrain 版本更新为 1.0.47。

## 2026-06-29 Admin Console 原始数据导入表格溢出修复

- 时间：2026-06-29 11:05:00
- 版本号：1.0.46
- 标题：修复 Admin Console 原始数据导入页字段超出列表
- 描述：原始数据导入页在中等宽度窗口下，注册数据源表格的"页面"等列会越过左侧列表区域，视觉上压到右侧"启动导入"面板，影响 PC 端浏览和操作。
- 是否完成：是
- 最终结果：为导入页两列布局增加专属宽度约束，注册数据源表格增加滚动容器、固定关键列宽和路径换行规则；PC 端不再与右侧面板重叠，窄屏继续按已有响应式规则单列显示。PMBrain 版本更新为 1.0.46。

## 2026-06-28 配置页面重新保存已注册知识库目录报错修复

- 时间：2026-06-28 12:38:00
- 版本号：1.0.45
- 标题：修复配置页面保存已注册的知识库目录时报 source_id_taken / overlapping_path 错误
- 描述：配置页面保存知识库目录时，如果该目录已经注册为 source，`addSource` 会抛 `source_id_taken`（id 相同）或 `overlapping_path`（id 不同但路径相同）错误，阻断保存流程。所有入口（桌面端 applySetup、管理后台 POST /admin/api/sources、CLI、MCP）最终都调用 `addSource`，因此问题影响面广。之前的桌面端修复靠正则匹配错误信息兜底，但 `overlapping_path` 的关键词 `overlaps` 不在正则中，且正则兜底本身脆弱。
- 是否完成：是
- 最终结果：在 `src/core/sources-ops.ts` 的 `addSource` 函数中新增 `isSameSourceSpec` 和 `realpathSafe` 辅助函数；当 source id 已存在且路径/URL 完全一致时，直接返回已有 source 行（幂等）；当 id 不同但路径完全相同时（realpath 比较），也返回已有 source 行；真正的子目录/父目录重叠仍抛 `overlapping_path` 错误。所有入口（CLI、MCP、HTTP admin、桌面端）统一受益，不再依赖正则兜底。Q4 pre-flight collision 测试全部通过。版本更新为 1.0.45。

## 2026-06-28 Docker/PGLite 切换 Source 注册冲突与 PGLite 锁冲突修复

- 时间：2026-06-28 12:00:00
- 版本号：1.0.44 / Desktop 1.0.34
- 标题：修复数据库切换时 source 已注册报错阻断切换，以及 PGLite 模式下 admin 导入锁超时
- 描述：从 PGLite 切回 Docker 时，`applySetup` 尝试重新注册 source ID，但目标数据库中该 source 已存在，`sources add` 报 `already registered`，而 `desktop/src/main/index.ts` 的忽略正则只匹配 `already exists|duplicate|已存在`，未覆盖 `already registered`，导致错误被抛出、配置回滚、切换失败。同时，PGLite 模式下 admin 控制台导入功能通过 `startRun` spawn 子进程执行 `import` 命令，子进程调用 `connectEngine()` → `acquireLock()` 获取 PGLite 锁，而 sidecar 主进程已持有同一数据目录的锁，子进程等待 30 秒后超时报 `Timed out waiting for PGLite lock`。PostgreSQL 模式无文件锁，此前未暴露此问题。
- 是否完成：是
- 最终结果：`index.ts` 的 source 注册忽略正则扩展为 `already exists|duplicate|已存在|already registered`，切换时 source 已存在不再阻断；`startRun` 改为 async 并增加 `RunHooks` 回调（`beforeSpawn`/`afterComplete`），PGLite 模式下 `serve-http.ts` 在 spawn 子进程前 `engine.disconnect()` 释放锁、子进程完成后 `engine.connect()` 重获锁；`api.ts` 所有 run starter 函数改为 async 并透传 hooks；版本更新为 PMBrain 1.0.44、Desktop 1.0.34。

## 2026-06-27 桌面端切库启动失败修复

- 时间：2026-06-27 22:15:00
- 版本号：1.0.41
- 标题：修复 Docker/PGLite 切换后 v0.11.0 smoke 误判任务表缺失
- 描述：桌面端保存配置后执行初始化检查时，v0.11.0 迁移 smoke 仍检查旧表名 `jobs`，当前 schema 使用 `minion_jobs`，导致 Docker 和 PGLite 均被误判为 `jobs table missing after schema migration`。
- 是否完成：是
- 最终结果：v0.11.0 smoke 同时兼容当前 `minion_jobs` 与旧 `jobs` 表名，并新增回归测试；切换 Docker/PGLite 不再被旧表名检查阻断。

## 2026-06-27 Windows 桌面端 PGLite legacy 路径与 WASM 报错修复

- 时间：2026-06-27
- 版本号：1.0.39 / Desktop 1.0.29
- 标题：修复从旧 GBrain 配置切换 PGLite 时默认复用 `.gbrain\brain.pglite` 并误报 macOS WASM 问题
- 描述：桌面端兼容读取旧 `.gbrain/config.json` 时，配置页会把旧 `.gbrain\brain.pglite` 当作 PGLite 默认路径；Windows 用户从 Postgres 或旧配置切换到 PGLite 后，可能尝试打开旧的或忙碌的 PGLite 数据目录，并把 `Aborted()` 误提示为 macOS 26.3 WASM bug。
- 是否完成：是
- 最终结果：桌面端仍可读取旧 `.gbrain` 配置以保留 API Key 和数据库信息，但切换到 PGLite 时默认写入 `.pmbrain/config.json` 并使用 `.pmbrain\brain.pglite`；Windows 上的 PGLite `Aborted()` 初始化失败改为提示旧库、忙碌目录或运行时重开失败，并建议关闭其他 PMBrain/GBrain 进程、选择新的 `.pmbrain` PGLite 路径或使用 Docker Postgres；补充桌面配置迁移和 PGLite 错误分类回归测试。

补充：PGLite 数据库路径现在会对用户选择的普通目录自动追加 `brain.pglite` 后缀，例如选择 `D:\PMBrainTest` 会保存为 `D:\PMBrainTest\brain.pglite`；已经是 `brain.pglite` 的路径不会重复追加。

## 2026-06-27 Migration 规范化：消除所有外部命令依赖

- 时间：2026-06-27
- 版本号：1.0.38 / Desktop 1.0.28
- 标题：修复 v0.11.0 非 PGLite 分支仍调用 pmbrain CLI 子进程、v0.32.2 依赖 git PATH
- 描述：上一轮已处理 PGLite 首装路径的 gbrain 子进程，但按 Migration 规范（不依赖 PATH、不调用 gbrain/pmbrain CLI、PGLite 进程内执行、可重复执行、空数据库成功、Windows 首装成功）逐项验收后发现残留：v0.11.0 的 Postgres/非 PGLite 分支仍通过 `pmbrain init --migrate-only`、`pmbrain jobs smoke`、`pmbrain autopilot --install` 调用 CLI 子进程；v0.32.2 通过 `execFileSync('git', ...)` 依赖 PATH 上的 git。
- 是否完成：是
- 最终结果：v0.11.0 非 PGLite 分支的三个 CLI 子进程入口全部改为进程内 engine 初始化；v0.32.2 的 git status 检查改为不依赖 PATH 的本地检查，失败时不再阻断迁移；v0.11.0 host-rewrite 中写入用户 cron 的命令从 `gbrain jobs submit` 改为 `pmbrain jobs submit`；migration 目录已无任何 `execSync/execFileSync/spawn` 外部进程调用；版本更新为 PMBrain 1.0.38、Desktop 1.0.28。

## 2026-06-27 Windows 桌面首装 v0.12+ 后续迁移仍调用 gbrain 修复

- 时间：2026-06-27
- 版本号：1.0.37 / Desktop 1.0.27
- 标题：修复 Windows 新用户保存配置并启动时 v0.12.0+ migration 调用 legacy gbrain 导致安装失败
- 描述：上一轮修复已处理 v0.11.0 和 PMBrain home/ledger，但 v0.12.0 之后的多个 migration orchestrator 仍通过 `execSync('gbrain ...')` 调用 schema 初始化、JSONB repair、frontmatter backfill 和统计校验；Windows 桌面安装包只包含 PMBrain sidecar，不包含 PATH 上的 `gbrain.exe`，因此新用户保存配置后会在 v0.12.0 或后续 migration 报 `'gbrain' is not recognized`。
- 是否完成：是
- 最终结果：新增 migration helper 直接使用当前 PMBrain 配置创建 engine 并执行 `initSchema()`；v0.12.2 JSONB repair、v0.13.0 frontmatter backfill、v0.16.0/v0.18.0/v0.18.1/v0.21.0/v0.29.1 schema phase 全部改为进程内执行；新增回归测试禁止 migration orchestrator 再 shell 到 legacy `gbrain`；doctor、apply-migrations 和相关迁移错误提示改为 `pmbrain`；版本更新为 PMBrain 1.0.37、Desktop 1.0.27，并重新生成 Windows 安装包。

## 2026-06-27 Windows 桌面首装迁移与 Admin Token 输出修复

- 时间：2026-06-27
- 版本号：1.0.36 / Desktop 1.0.26
- 标题：修复 Windows 全新用户首次安装出现 WEDGED 与 gbrain 命令缺失，并修复 Admin Token 不显示明文
- 描述：全新 Windows 桌面安装时，迁移 ledger 与偏好路径仍可能落到旧 `.gbrain`，v0.11.0 migration 还会在 PGLite 首装链路中执行 `gbrain` 子命令；手动 `pmbrain serve --http` 时，来自环境变量或配置的 Admin Token 只显示来源不显示可复制 token。
- 是否完成：是
- 最终结果：迁移状态和偏好统一走 PMBrain active home；桌面 `save-setup` 调用迁移时使用内置 sidecar 并跳过 host autopilot；PGLite v0.11.0 schema 初始化改为进程内执行且不再依赖 `gbrain.exe`；WEDGED 和迁移帮助文案改为 PMBrain；Admin Token 在非 suppress 场景下输出明文；版本更新为 PMBrain 1.0.36、Desktop 1.0.26，并重新生成 Windows 安装包。

## 2026-06-26 op_checkpoints.completed_keys 非数组值破坏恢复进度

- 时间：2026-06-26 23:10:00
- 版本号：1.0.31
- 标题：修复 checkpoint JSONB 标量值导致恢复状态不可用
- 描述：`op_checkpoints.completed_keys` 语义上必须是字符串数组，但数据库层此前没有 CHECK 约束；外部脚本或旧二进制若写入 JSONB 标量，读取端可能进入解析失败路径，导致本轮 checkpoint 恢复状态被丢弃。
- 是否完成：是
- 最终结果：fresh schema 与 migration v108 均添加 `op_checkpoints_completed_keys_array` 约束；迁移会把已有非数组值修复为空数组；读取端对非数组值给出专门 warning 并跳过。

## 2026-06-26 supervisor crash storm 永久停摆修复

- 时间：2026-06-26 22:35:00
- 版本号：1.0.30
- 标题：修复 supervisor 达到软 crash 预算后永久停止的问题
- 描述：原 supervisor 达到 `maxCrashes` 后直接触发永久停止，临时数据库或连接池故障可能导致后台队列无人恢复。移植上游 #1994 的 degraded retry：软预算只告警和退避，硬上限才永久停止。
- 是否完成：是
- 最终结果：默认硬上限为 `maxCrashes * 10`，可用 `PMBRAIN_SUPERVISOR_HARD_STOP_CRASHES` 覆盖，设置 `0` 表示不自动永久停止。

## 2026-06-26 sync 导入阶段停滞中止修复

- 时间：2026-06-26 22:00:00
- 版本号：1.0.29
- 标题：修复同步进程存活但导入无进度时无法自动释放的风险
- 描述：同步进程可能仍在刷新 per-source DB lock heartbeat，但导入阶段长时间没有文件完成，界面和状态会显示仍在 running。移植上游 #1950 的 progress-aware stall watchdog，并按 PMBrain 环境变量前缀适配。
- 是否完成：是
- 最终结果：导入阶段无进度超过阈值会触发 abort，返回 `partial` 且 reason 为 `stall_timeout`，不推进 `last_commit`；下次同步可从原 checkpoint 继续。

## 2026-06-26 minion 超时尝试次数计数修复

- 时间：2026-06-26 21:20:00
- 版本号：1.0.28
- 标题：修复 handleTimeouts 超时任务未计入 attempts_made 的问题
- 描述：按 `PMBrain-local-upstream-fusion-plan.md` 的后台任务稳定性组，移植 GBrain `bb2e88c4` 中 #1737 的关键 diff。PMBrain 的超时处理逻辑内联在 `src/core/minions/queue.ts`，因此只在现有 SQL 中补充 `attempts_made = attempts_made + 1`，不新增第二套 handler-timeouts 文件。
- 是否完成：是
- 最终结果：超时被 `handleTimeouts()` 直接 dead-letter 的长任务现在会显示真实消耗 1 次尝试；已补充单元测试和 E2E 断言；版本号更新为 1.0.28。

## 2026-06-26 Dream synthesize 读取 Codex 会话与会议记录修复

- 时间：2026-06-26
- 版本号：1.0.26
- 标题：修复 Dream synthesize 无法直接读取 Codex JSONL 会话和中文会议记录
- 描述：`dream.synthesize.session_corpus_dir` 指向 Codex sessions、`dream.synthesize.meeting_transcripts_dir` 指向会议目录时，Codex `.jsonl` 会被当作原始事件流文本处理，会议 `.txt` 在 GB18030 编码下会被 UTF-8 误读成乱码，导致后续摘要页面无法基于真实正文生成。
- 是否完成：是
- 最终结果：Dream transcript discovery 现在递归识别 `.txt`、`.md`、`.jsonl`，Codex JSONL 会抽取 user/assistant 文本消息，会议文本会在 UTF-8 与 GB18030 间择优解码，并支持 `20260514`、`rollout-2026-06-06` 等日期形态。已用用户提供的最小目录验证可发现 2 条 Codex 会话和会议记录，版本更新为 1.0.26。

## 2026-06-25 Windows 桌面端 Office/PDF 导入运行时缺失

- 时间：2026-06-25 09:04:39
- 版本号：1.0.25
- 标题：修复桌面端打包后导入 Office/PDF 时缺少 @napi-rs/canvas
- 描述：安装版执行 `import ... --include-office` 时，sidecar 能启动命令但在解析 `pdf-parse` 依赖时找不到 `@napi-rs/canvas`，随后 DOMMatrix/ImageData/Path2D polyfill 失败并报 `DOMMatrix is not defined`。
- 是否完成：是
- 最终结果：sidecar runtime 组装脚本显式复制 `@napi-rs/canvas` 与 Windows 原生包 `@napi-rs/canvas-win32-x64-msvc`，打包校验同步检查 canvas JS 与 `.node` 原生文件，版本更新为 1.0.25。

## 2026-06-23 全项目代码审查与桌面运行稳定性修复

- 时间：2026-06-23
- 版本号：1.0.23
- 标题：修复 Source 配置迁移泄密风险和桌面 sidecar 残留进程
- 描述：全项目基线检查发现数据库切换会原样序列化 Source 配置，桌面 sidecar 启动超时或恢复失败时可能遗留子进程，技能路由与 frontmatter 解析器在 Windows CRLF 文件上会产生大面积误报；安装包名称也未明确标注 Windows 平台。
- 是否完成：是
- 最终结果：Source 配置迁移统一经过敏感字段脱敏；sidecar 启动失败及每次恢复失败后均会终止当前子进程；自动更新的首次检查定时器可随退出清理；MCP 客户端版本改为读取应用版本；技能路由、frontmatter 与 manifest 解析兼容 CRLF；安装包更名为 `PMBrain-Windows-x64-Setup-1.0.23.exe`，发布工作流与用户文档同步更新。

## 2026-06-23 Windows 桌面安装包运行时与窗口唤醒修复

- 时间：2026-06-23
- 版本号：1.0.22
- 标题：修复安装后缺少 PGLite 模块、图标无法唤醒窗口及失败状态误报
- 描述：1.0.21 构建目录包含 PGLite，但 electron-builder 在宽泛复制 `extraResources` 时过滤了嵌套 `node_modules`，安装后 sidecar 无法解析 `@electric-sql/pglite/vector`；同时桌面窗口仅依赖 `ready-to-show`，单实例事件不能重建或强制显示窗口，服务失败时只要带端口又会被错误显示为"服务已就绪"。
- 是否完成：是
- 最终结果：PGLite package、vector 导出和 WASM/data 资源改为显式写入安装包，并新增构建后硬校验；窗口加载完成后强制显示，二次启动会显示、恢复、聚焦或重建窗口，所有窗口关闭后退出进程；失败状态不再误报就绪，老用户启动失败进入独立恢复页，正常启动仍直接进入管理台。新增桌面版安装与首次使用文档，版本更新为 1.0.22。

## 2026-06-20 ChatGPT Tunnel Header YAML 格式修复

- 时间：2026-06-20
- 版本号：1.0.18 / 0.41.29.2
- 标题：修复 ChatGPT Tunnel profile 无法通过 Doctor 解析
- 描述：Admin Console 生成的 `mcp.extra_headers` 与 `mcp.discovery_extra_headers` 使用了 YAML 序列，但 tunnel-client 0.0.9 要求 `map[string]string`，导致 `profile_load` 报 `cannot unmarshal !!seq into map[string]string`。
- 是否完成：是
- 最终结果：两组 Header 改为 `Authorization: file:...` 映射格式，保留仓库外私密引用；补充 tunnel-client 所需的 `/.well-known/oauth-protected-resource/mcp` 路径型元数据；Doctor 子进程改为异步执行，避免 Admin 请求阻塞 PMBrain 自身的元数据探测；Windows 已启用系统代理时自动写入 `control_plane.http_proxy`，避免 OpenAI 直连超时且不代理本地 MCP；增加回归断言防止再次生成列表格式。

## 2026-06-18 Dream dry-run、模型诊断与帮助文案修复

- 时间：2026-06-18 09:23:47
- 版本号：1.0.12
- 标题：修复 dream dry-run 卡 LLM、models doctor 参数解析、PM 阶段 dry-run 与帮助文案过期
- 描述：`propose_takes --dry-run` 仍会调用 LLM，容易长时间卡住；`models doctor` 因子命令参数下标判断错误，直接执行时只显示模型路由表；`project_health`、`risk_detect` 未收到 dry-run 参数；`dream --help` 仍描述旧阶段和旧审批流程。
- 是否完成：是
- 最终结果：`propose_takes` dry-run 现在只扫描并统计需要 LLM 的页面，不调用 LLM、不写候选观点；`models doctor` 正常进入探针模式；PM 三阶段 dry-run 参数已传递；`dream --help` 更新为真实阶段列表和"候选观点 -> 观点审批 -> takes -> 校准画像"流程说明。

## 2026-06-18 Dream 校准阶段 source 作用域修复

- 时间：2026-06-18 09:14:45
- 版本号：1.0.11
- 标题：修复 dream 校准三阶段忽略显式 source 的问题
- 描述：执行 `dream --source <id>` 时，`propose_takes`、`grade_takes`、`calibration_profile` 已经通过命令行解析得到 `opts.sourceId`，但校准上下文仍按 `brainDir` 重新推断 source，导致显式 source 可能被覆盖，进而扫描错误的数据范围。
- 是否完成：是
- 最终结果：校准三阶段现在优先使用 `opts.sourceId`，仅在未传入 source 时才回退到 `resolveSourceForDir(engine, opts.brainDir)`；新增结构回归测试防止该路径回退。

## 2026-06-16 全局 pmbrain 命令入口修复

- 时间：2026-06-16
- 版本号：1.0.7
- 标题：修复全局 pmbrain 入口版本不一致和 help 误报失败
- 描述：系统 PATH 中的 `pmbrain`/`gbrain` 仍指向旧全局安装版本，直接执行 `pmbrain dream` 会绕过当前 PMBrain 源码修复；同时 `embed --help` 与 `config --help` 虽打印 Usage 但返回错误码 1，容易被自动化判断为命令不可执行。
- 是否完成：是
- 最终结果：全局 `pmbrain.cmd`/`gbrain.cmd` 已转发到当前项目源码；`pmbrain --version` 与 `gbrain --version` 均返回当前版本；`embed --help` 和 `config --help` 改为正常返回。

## 2026-06-16 Dream MIMO 价格配置缺失

- 时间：2026-06-16
- 版本号：1.0.5
- 标题：修复 Dream propose_takes 使用 MIMO 时提示价格未配置
- 描述：`pmbrain dream` 在 `propose_takes` 阶段使用 `mimo:mimo-v2.5-pro` 时，旧 Dream budget meter 只读取 Anthropic 价格表，导致 `BUDGET_METER_NO_PRICING` 并让预算计量失效；新 `BudgetTracker` 也缺少通用 provider recipe 价格读取。
- 是否完成：是
- 最终结果：预算计量器现在会读取 provider recipe 中的 chat 输入/输出单价，MIMO 按 `$1.25/$10.00 per 1M tokens` 计入预算；`models.propose_takes` 与 `models.grade_takes` 已确认均为 `mimo:mimo-v2.5-pro`，本地 HTTP 服务已启动并通过 `/health` 检查。

## 2026-06-11 Admin 自然语言导入 source 解析错误

- 时间：2026-06-11
- 标题：修复 Admin 自然语言导入已注册 source 路径时落到 default
- 描述：从 Admin 自然语言任务导入 `D:\duwu\youdao\订单+清单项目` 时，命令生成为 `bun src/cli.ts import ... --include-office`，没有带 `--source-id dingdan-qingdan`。该目录已注册为 source `dingdan-qingdan`，但执行层解析为 `default`，导致已存在页面建版本快照时报 `createVersion failed: page "项目管理" (source=default) not found`。
- 是否完成：是
- 最终结果：Admin 执行 import_path 时会根据导入路径匹配 sources.local_path 的最长前缀，自动补齐正确 `--source-id`；显式传入 sourceId 时仍优先使用用户指定值。按版本规则将 PMBrain 从 `1.0.2` 更新为 `1.0.3`。

## 2026-06-11 HTTP 服务启动后立即退出

- 时间：2026-06-11
- 标题：修复 `serve --http` 打印启动信息后立即返回命令行
- 描述：执行 `bun run src/cli.ts serve --http` 后，终端打印 PMBrain MCP Server banner 和 Admin Token，但马上回到 PowerShell 提示符，HTTP 服务随即掉线。根因是 `runServeHttp` 只调用 `app.listen(...)`，没有保存 HTTP server 并等待其关闭，导致 async 函数返回后 CLI 生命周期结束。
- 是否完成：是
- 最终结果：`runServeHttp` 现在保存 HTTP server，并等待 server close/error 或 SIGINT/SIGTERM；关闭时走统一清理并断开 engine。二次复查发现"下方终端仍起不来"的直接原因是 3131 已有后台 PMBrain 服务占用；同时修正 listen 时序，只有端口真正监听成功后才打印 banner/token，端口冲突时不再误导性显示启动成功。按版本规则将 PMBrain 从 `1.0.0` 更新到 `1.0.2`。已通过 `serve-http-bootstrap-token` 测试、端口冲突复现验证、临时端口真实启动保持存活验证。

## 2026-06-10 系统诊断运行结果不持久显示

- 时间：2026-06-10
- 标题：修复 doctor 运行后结果不刷新且切页后丢失
- 描述：系统诊断页点击"运行 doctor --fast"后只读取一次 run 状态，长任务尚未完成时页面不会继续刷新；切换页面再回来也不会拉取本次服务内已有 doctor 运行记录。
- 是否完成：是
- 最终结果：系统诊断页新增运行状态轮询，并在页面加载时从 `/admin/api/runs` 恢复最近 doctor 记录；切页回来后仍可查看本次服务运行记录和输出。

## 2026-06-10 登录页品牌与登录链接说明修复

- 时间：2026-06-10
- 标题：修复 Admin 登录页仍显示 GBrain 且登录链接说明不清晰
- 描述：登录页品牌仍显示 `GBrain`，且"向 AI Agent 索取管理员登录链接"的说明容易让用户误以为链接需要粘贴到管理员令牌输入框。
- 是否完成：是
- 最终结果：登录页品牌改为 `PMBrain`；登录链接说明改为"Agent 返回 URL 后直接在浏览器打开"，并明确下方输入框仅用于粘贴终端打印的 Admin Token。

## 2026-06-10 Admin Token 复制体验修复

- 时间：2026-06-10
- 标题：修复启动横幅中的 Admin Token 被拆成多行影响复制
- 描述：`serve --http` 启动横幅此前将随机 Admin Token 按 50 字符拆成两行，并带有框线和填充空格，用户从终端复制时容易把空格、分隔符或换行一起复制到登录框。
- 是否完成：是
- 最终结果：Admin Token 改为单独的原始单行输出，可直接复制粘贴到 `/admin` 登录框；补充回归测试确保 token 不再被人为拆行。

## 2026-06-08 向量化配置分裂导致智普费用消耗排查

- 时间：2026-06-08
- 标题：修复文件配置仍指向智普 embedding 导致继续消耗智普额度
- 描述：数据库中 4247 个 chunk 均已使用 `zeroentropyai:zembed-1` 完成向量化且无待向量化任务，但文件平面 `~/.gbrain/config.json` 仍配置为 `zhipu:embedding-3` / 1024，导致后续搜索或新导入可能继续调用智普生成 query/document embedding。
- 是否完成：是
- 最终结果：将文件平面 embedding 配置改回 `zeroentropyai:zembed-1` / 1280；验证 `embed --stale --dry-run` 显示 0 个待向量化 chunk，数据库中非 ZE chunk 为 0。该配置文件位于用户目录，不纳入仓库提交。

## 2026-06-08 自然语言任务解析与单文件导入修复

- 时间：2026-06-08
- 标题：修复自然语言任务框无法解析 MIMO tool call 与单个 md 文件导入
- 描述：自然语言任务预览接口此前主要假设 LLM 返回纯 JSON 文本，遇到 MIMO 返回 tool_calls、function_call 或结构化结果时会因为 result.text 为空报 `LLM did not return a JSON object: (empty)`；同时 `import_path` 传入单个 `.md/.mdx` 文件时会被当作目录扫描，导致导入 0 个文件。
- 是否完成：是
- 最终结果：新增 `pmbrain_action` 工具规划 schema 和多形态 LLM 返回解析，兼容 tool_calls、function_call、structured_output、content parts、markdown JSON 与 gateway tool-call blocks；`import_path` 自动补充 `pathType`；`gbrain import <file.md>` 支持按单文件导入并记录 `source_type=file`。已新增并通过 `test/admin-console-intent.test.ts` 与 `test/import-single-file.test.ts`。

## 2026-06-06 本地数据库无法连接

- 时间：2026-06-06
- 标题：PMBrain 本地数据库无法连接
- 描述：执行 PMBrain 命令时 PGLite 报 `PGLite failed to initialize its WASM runtime. Original error: Aborted().`，本地 HTTP 服务也无法连接。
- 根因：当前 Windows + Bun 环境下 PGLite WASM 不稳定；项目此前已验证可行路径是 Docker Postgres，但 Docker Desktop 和 `gbrain-pg` 容器处于停止状态，配置又被切回了 PGLite。
- 解决方案：启动 Docker Desktop，恢复 `gbrain-pg` 容器，配置统一切回 `postgresql://postgres:postgres@localhost:5433/gbrain`，并清理失败运行遗留的 cycle lock。
- 是否完成：是
- 最终结果：Docker Postgres 正常运行，`stats` 可读取 525 页、10036 chunks 且全部 embedded；HTTP 服务 `http://localhost:3131/admin/` 和 `/health` 均返回 200，`/health` 显示 `engine=postgres`。

## 2026-06-06 legacy .doc 导入不可用

- 时间：2026-06-06
- 标题：修复 legacy .doc 文档导入依赖缺失时不可用
- 描述：Office 导入已识别 .doc 扩展名，但在未安装 LibreOffice/soffice 的 Windows 环境下无法抽取正文。
- 根因：legacy .doc 仅依赖 LibreOffice 转换为 docx，缺少 Microsoft Word 本机环境的只读抽取兜底。
- 解决方案：为 .doc/.wps 导入增加 Windows Word COM 只读文本抽取 fallback，并补充常见 LibreOffice 安装路径检测。
- 是否完成：是
- 最终结果：未安装 LibreOffice 时，Windows 可通过已安装的 Microsoft Word 只读打开 legacy .doc 并直接导入知识库；原文档不被修改。

## 2026-06-02 PowerShell 编码问题导致 load-env.ps1 报错

- 时间：2026-06-02
- 标题：load-env.ps1 报"字符串缺少终止符"
- 描述：执行 `. .\load-env.ps1` 报错 `ParserError: 字符串缺少终止符: "`。
- 根因：`write_to_file` 工具写入的 .ps1 文件编码与 PowerShell 不兼容。
- 解决方案：用 `Set-Content -Encoding UTF8` 重新写入文件，简化脚本内容避免特殊字符。
- 是否完成：是
- 最终结果：`load-env.ps1` 可正常执行。

## 2026-06-02 MCP 服务连接失败

- 时间：2026-06-02
- 标题：MCP 报错 Connection closed / Module not found
- 描述：CodeBuddy 连接 MCP 报错 `MCP error -32000: Connection closed` 和 `error: Module not found "src/cli.ts"`。
- 根因：MCP 启动时当前工作目录不是 PMBrain 目录，相对路径 `src/cli.ts` 找不到。
- 解决方案：在 MCP 启动命令中加入 `cd d:\cursor-claude\PMBrain`。
- 是否完成：是
- 最终结果：MCP 连接正常，AI 可正常调用 PMBrain 工具。

## 2026-06-02 Embed 连接 OpenAI API 失败

- 时间：2026-06-02
- 标题：OpenAI API 无法连接（国内网络限制）
- 描述：`embed` 报错 `Cannot connect to API: Unable to connect. Is the computer able to access the url?`，但 `Bun.fetch` 直接测试 OpenAI 正常。
- 根因：`provider_base_urls` 配置对 `native` 类型的 OpenAI recipe 无效，SDK 仍走官方端点。
- 解决方案：创建自定义 `mimo` recipe（`openai-compatible` 类型），通过 `base_url_default` 指向 MIMO API 端点。后改用智谱 `embedding-3`（国内直连）。
- 是否完成：是
- 最终结果：改用智谱 embedding-3（国内直连）后嵌入成功。

## 2026-06-02 嵌入维度不匹配（1280 vs 1536）

- 时间：2026-06-02
- 标题：嵌入列维度不匹配导致 embed 拒绝执行
- 描述：初始 schema 使用 ZeroEntropy 默认（1280d），后来改为 OpenAI 的 1536d，数据库列宽不匹配。报错 `Refusing to silently re-template existing brain. Existing column: vector(1280), Requested: vector(1536)`。
- 根因：首次初始化时 schema 按默认嵌入模型（ZeroEntropy）建了 1280d 列，切换模型后维度冲突。
- 解决方案：在 Docker Postgres 中执行 SQL 修改列宽（`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(N)`），后续更换模型时重复此步骤。
- 是否完成：是
- 最终结果：列宽修改后嵌入正常。后续每次换嵌入模型需同步修改列宽。

## 2026-06-02 Embed 命令报"嵌入模型未配置"

- 时间：2026-06-02
- 标题：embed --stale 提示 deferred setup 未配置嵌入模型
- 描述：执行 `embed --stale` 报错 `This brain was initialized with --no-embedding (deferred setup)`。原因是首次 `gbrain init` 时用了 `--no-embedding`，导致 `~/.gbrain/config.json` 中残留 `embedding_disabled: true`。
- 根因：`--no-embedding` 初始化标记未在后续配置中被清除。
- 解决方案：手动编辑 `~/.gbrain/config.json` 删除 `embedding_disabled` 字段，添加 `embedding_model` 和 `embedding_dimensions`。
- 是否完成：是
- 最终结果：配置文件修复后 `embed --stale` 正常执行。

## 2026-06-02 Docker Desktop 启动失败

- 时间：2026-06-02
- 标题：Docker Desktop 无法启动（WSL 未安装）
- 描述：执行 `docker run` 报错 `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`，Docker 服务状态为 Stopped。`wsl -l -v` 报错（WSL 未安装）。
- 根因：Windows 未安装 WSL2，Docker Desktop 依赖的 Linux 容器后端缺失。
- 解决方案：通过 Docker Desktop 设置启用 WSL2 后端（启动时自动提示安装），等待约 10 秒后 Docker 就绪。
- 是否完成：是
- 最终结果：Docker Desktop 正常启动，`docker ps` 返回正常。

## 2026-06-02 PGLite WASM 在 Windows 下崩溃

- 时间：2026-06-02
- 标题：PGLite WASM 初始化失败（Aborted()）
- 描述：在 Windows + Bun 1.3.14 环境下执行 `gbrain init --pglite` 报错 `PGLite failed to initialize its WASM runtime. Original error: Aborted(). Build with -sASSERTIONS for more info.`。尝试升级 `@electric-sql/pglite` 从 0.4.3 到 0.4.6 无效。Bun 已是最新版本（1.3.14）。
- 根因：Bun on Windows 与 `@electric-sql/pglite` WASM 有已知兼容性问题。
- 解决方案：改用 Docker Postgres 引擎（`pgvector/pgvector:pg16` 容器 + `gbrain init --url`），绕过 PGLite 路径。
- 是否完成：是
- 最终结果：Docker Postgres 方案成功运行，Schema 107 版全部迁移通过。
## 2026-07-03 Dream 会议文件夹只处理 1 份 transcript

- 时间：2026-07-03
- 版本号：1.0.66
- 标题：修复显式会议文件夹输入被 significance filter 跳过
- 描述：执行 `dream --phase synthesize --input D:\LenovoSoftstore\huiyijilu` 时，系统发现 12 份 transcript，但只进入 1 份综合处理，最终只生成 3 个知识点/页面，不符合会议记录逐场整理预期。
- 根因：显式指定文件夹仍复用普通“个人知识点是否值得沉淀”的 significance filter；会议整理缺少会议纪要页输出约束，且 Dream allow-list 未包含 `wiki/meetings/*`。
- 解决方案：显式输入文件夹时跳过普通 significance filter，全部可读 transcript 都进入综合处理；允许写入 `wiki/meetings/*`；synthesize 子任务提示词要求会议 transcript 先写会议纪要页，再额外沉淀观点。
- 是否完成：是
- 最终结果：dry-run 验证 `D:\LenovoSoftstore\huiyijilu` 从 “1 of 12” 修复为 “10 of 12 transcripts would synthesize”；其中 12 个文件包含 10 份唯一 transcript，2 份重复路径会在 `duplicate_skips` 中展示并跳过。
## 2026-07-03 Dream 显式输入缺少 AI 会话整理产物

- 时间：2026-07-03
- 版本号：1.0.67
- 标题：补齐 Codex/AI 会话文件夹整理能力
- 描述：用户希望 `C:\Users\zhengyunhui\.codex\sessions` 这类 Codex 对话路径也能像会议记录一样整理进知识库。
- 根因：transcript discovery 已支持 `.jsonl` 会话读取，但 Dream synthesize 的产出规则只新增了会议纪要页，未把 AI/session conversation 作为显式整理主产物，allow-list 也未包含 `wiki/conversations/*`。
- 解决方案：在 synthesize 提示词中新增 AI/session conversations 任务，要求 Codex/ChatGPT/Claude/agent logs 等会话先写 `wiki/conversations/...` 会话整理页；同步开放 `wiki/conversations/*` 写入白名单。
- 是否完成：是
- 最终结果：显式输入 AI 会话文件夹时，会像会议整理一样逐份进入 synthesize，并优先产出会话整理页。

## 2026-07-04 Dream 打包运行时缺少 synthesize allow-list

- 时间：2026-07-04
- 版本号：1.0.70
- 标题：修复桌面 sidecar 在普通用户 brain 中报 NO_ALLOWLIST
- 描述：桌面打包运行 `dream --phase synthesize --input <会话目录>` 时，如果当前工作目录或用户 brain 中没有 `skills/_brain-filing-rules.json`，会失败并提示 `skills/_brain-filing-rules.json missing dream_synthesize_paths.globs`。
- 根因：synthesize/patterns 的 allow-list loader 只查 `process.cwd()/skills/_brain-filing-rules.json` 和源码相对路径；桌面 sidecar 打包后没有真实源码 `skills` 目录，普通生产环境不能保证用户 brain 自带该文件。
- 解决方案：新增共享 allow-list loader，显式规则文件优先；缺失或旧格式时，回退到打包内置的 canonical `_brain-filing-rules.json`，并合并 active schema pack 派生路径；synthesize 和 patterns 共用该 loader。
- 是否完成：是
- 最终结果：重建桌面 sidecar 后，在无 `skills` 文件夹的临时工作目录中 dry-run `C:\Users\zhengyunhui\.claude\projects`，结果为 `dry-run: 19 of 20 transcripts would synthesize`，不再报 `NO_ALLOWLIST`。
## 2026-07-04 Dream system skill 初始化链路补强

- 时间：2026-07-04
- 版本号：1.0.71 / Desktop 1.0.40
- 标题：Dream 执行前补齐 system skill 自愈与桌面打包校验
- 描述：在桌面端打包校验中把 `_brain-filing-rules.json` 和 `_brain-filing-rules.md` 设为必备运行时文件；Dream 入口在执行 cycle 前补齐系统 skill 资产，并提前校验 `--input` 路径是否存在，避免底层 ENOENT 或 allow-list 缺失错误直接暴露。
- 是否完成：是
- 最终结果：已补测试并验证 targeted tests 通过；桌面端安装包已重新构建为 1.0.40，发布产物 dry-run 与缺失输入路径校验均通过。
 
## 2026-07-08 桌面端安装包开发路径泄漏与运行时资源缺失

- 时间：2026-07-08
- 版本号：Desktop 1.0.46
- 标题：修复桌面端安装包包含开发机路径与 runtime 资源缺失风险
- 描述：桌面端 sidecar 打包后可能携带开发机绝对路径，同时 packaged runtime 缺少 recipes、templates、完整 skills 和部分运行期依赖，存在新用户安装后 integrations/skill 自检失败、自动更新产物不完整的风险。
- 是否完成：是
- 最终结果：已恢复桌面端构建脚本，补齐 packaged runtime 资源与外置依赖复制，改造运行时资源路径解析，增强安装包校验脚本检查版本、latest.yml、必备资源和开发机路径泄漏；未处理代码签名问题。

## 2026-07-08 桌面端配置文件 UTF-8 BOM 读取失败

- 时间：2026-07-08
- 版本号：Desktop 1.0.47
- 标题：修复 Windows 工具写入 BOM 后桌面端无法读取 config.json
- 描述：用户本机 `.pmbrain/config.json` 以 UTF-8 BOM 开头，PowerShell 可解析但 Bun/Node 的 `JSON.parse(readFileSync(...))` 报错，导致桌面端初始化页显示无法读取 PMBrain 配置。
- 是否完成：是
- 最终结果：已备份并重写本机配置为无 BOM；桌面端配置读取和核心 `loadConfig` 均兼容开头 BOM，并新增回归测试覆盖该场景。

## 2026-07-09 Dream 完整周期数据库连接异常

- 时间：2026-07-09
- 版本号：PMBrain 1.0.84
- 标题：修复 Dream 完整周期中 sync/synthesize 报 connect() 未调用
- 描述：完整 Dream dry-run 中 `lint` 阶段会为读取 DB 配置临时创建并关闭 Postgres module-level engine，导致后续 `sync`、`synthesize` 等阶段复用已断开的共享连接并报 `connect() has not been called`。
- 是否完成：是
- 最终结果：Dream 的 `lint` 阶段改为复用当前 cycle 已连接的 engine 读取配置，不再自行开关共享连接；完整 `dream --dry-run --max-pages 1 --json` 验证 `sync/synthesize` 不再报连接异常。

## 2026-07-09 桌面端 Dream 找不到本地知识库目录

- 时间：2026-07-09
- 版本号：PMBrain 1.0.85
- 标题：修复桌面端 Admin 运行 Dream 报 No brain directory found
- 描述：用户通过桌面端首次配置保存了 `desktop.knowledge_directory`，但 Admin Console 启动 Dream 时命令未传 `--dir`，Dream 目录解析只读取 `--dir` 和数据库配置 `sync.repo_path`，导致报 `No brain directory found. Pass --dir <path> or configure one via gbrain init`。
- 根因：桌面端知识库目录保存在文件配置的 `desktop.knowledge_directory`，而 Dream 命令未把该字段作为 brain 目录 fallback。
- 解决方案：Dream 的 `resolveBrainDir` 在 `--dir` 和 `sync.repo_path` 都不可用时，回退读取文件配置中的 `desktop.knowledge_directory`，并仅在目录存在时使用；补充回归测试覆盖桌面配置 fallback。
- 是否完成：是
- 最终结果：桌面端 Admin 直接运行 Dream 时，可使用首次配置保存的本地知识库目录，不再要求用户额外手动设置 `sync.repo_path`。

## 2026-07-09 Admin 帮助中心 README 缺失报错

- 时间：2026-07-09
- 版本号：PMBrain 1.0.86
- 标题：修复帮助中心在安装目录缺少 README.md 时直接报错
- 描述：桌面端/安装版 Admin Console 打开帮助中心时，后端文档接口直接读取运行目录相对路径下的 `README.md`；安装目录 `D:\Program Files\PMBrain\README.md` 不存在时，接口返回 `ENOENT`，页面只显示红色错误。
- 根因：帮助中心把源码仓库 README 当成必备运行时文件，但打包后的 runtime 不保证携带该文件。
- 解决方案：文档接口改为按多个源码/运行时候选路径尝试读取 README；全部找不到时返回“暂无”占位，并保留 FAQ 为“暂无”，避免帮助中心因缺失文档资源返回 500。
- 是否完成：是
- 最终结果：帮助中心在 README 缺失时仍能正常打开，显示“暂无”，后续可再补充正式帮助文档资源。

## 2026-07-09 桌面端 PDF 导入缺少 pdf.worker.mjs

- 时间：2026-07-09 17:49:48
- 版本号：Desktop 1.0.49
- 标题：修复安装版导入 PDF 时找不到 pdf.worker.mjs
- 描述：安装版执行 Office/PDF 导入时，`pdf-parse` 在解析 PDF 文本阶段尝试从运行目录加载 `./pdf.worker.mjs`，但桌面端 runtime 组装未复制该 worker 文件，导致导入任务在 `import.collect_files` 阶段报 `Setting up fake worker failed: Cannot find module './pdf.worker.mjs'`。
- 根因：`pdf-parse` 的 PDF worker 属于运行时动态加载资源，不会自动内联进 Bun 单文件 sidecar；原有桌面打包脚本和安装包校验只覆盖了 canvas、PGLite 等外置依赖，未覆盖 PDF worker。
- 解决方案：桌面端 sidecar runtime 组装时从 `node_modules/pdf-parse/dist/worker/pdf.worker.mjs` 复制到 `pmbrain-runtime/pdf.worker.mjs`；安装包校验同步检查该文件存在且非空，避免后续打包遗漏。
- 是否完成：是
- 最终结果：下次执行桌面端打包流程时，`pdf.worker.mjs` 会随 `resources/pmbrain-runtime` 一起进入安装包，PDF 导入不再因缺少 worker 文件失败。

## 2026-07-09 GitHub Actions CI 失败与 skill 引用缺失

- 时间：2026-07-09
- 版本号：PMBrain 1.0.87
- 标题：修复 GitHub Actions 测试失败和两个本地 skill 未纳入仓库
- 描述：Actions 中单元测试、skill resolver 和 E2E 流水线失败，主要由 PMBrain 改名后的旧 `gbrain` 文案断言、`.pmbrain` home 迁移、fake engine 缺少可选 `getConfig`、doctor 分类缺项、OpenAI-compatible 默认维度断言、Windows 路径差异，以及 `momo-ai-tutorial` / `yunhui-style-writer` 两个 skill 目录被本地 exclude 未提交导致。
- 根因：本地仓库存在 legacy `gbrain` 兼容逻辑和 PMBrain 新品牌/新 home 目录之间的测试漂移；部分测试 fake 未覆盖真实 engine 接口可选性；skill 文件被 `.git/info/exclude` 忽略，导致 CI checkout 缺少 resolver 引用的文件。
- 解决方案：补齐两个 skill 的 manifest 引用和 conformance 章节；让 source resolver / doctor 对可选 `getConfig` 更稳健；同步 PMBrain 用户可见文案与测试预期；修正 `.pmbrain` home、Windows 路径和 OpenAI-compatible embedding 维度相关测试；补上 `lock_renewal_health` 分类。
- 是否完成：是
- 最终结果：相关 targeted tests 已在本地通过；完整 resolver/skill conformance 在本机受未跟踪 skill 目录影响，改用针对新增两个 skill 的校验确认 manifest、frontmatter 和必需章节齐全。

## 2026-07-10 桌面端向量维度自动配置与数据库对齐

- 时间：2026-07-10
- 版本号：PMBrain 1.0.88；Desktop 1.0.50
- 标题：修复智谱 embedding-3 配置 1024 但数据库列仍为 1280 导致导入失败
- 描述：桌面端取消向量维度输入框，新选择的已知向量模型自动采用推荐维度；老用户在模型未变化时继续保留原配置维度。保存配置后通过 CLI 检查数据库实际向量列宽并自动对齐。
- 根因：历史数据库可能先按默认 `vector(1280)` 建表，桌面端后来保存 `zhipu:embedding-3` 的 1024 维配置时只执行通用迁移，没有调整既有向量列；界面配置、API 输出和数据库列宽因此不一致。
- 解决方案：新增 `models align-embedding-dimension` 通用 CLI 能力，在事务中只重建主文本向量列和对应索引，保留页面、分块、原始资料及独立的图片/多模态向量列；桌面端保存流程在最后调用该能力。新配置的智谱 embedding-3/embedding-2 推荐维度为 1024，未知自定义模型通过一次短请求探测实际输出长度，老用户原维度不被静默覆盖。
- 是否完成：是
- 最终结果：1024 与历史 1280 列不一致时可自动对齐；旧文本向量会置空等待重新向量化，所有原始知识数据保持不变。桌面配置、核心维度迁移和既有检索升级路径均有回归测试覆盖。

## 2026-07-10 桌面端模型切换、Ollama 发现与 Think 厂商路由

- 时间：2026-07-10
- 版本号：PMBrain 1.0.89；Desktop 1.0.51
- 标题：修复模型配置排版、厂商内模型切换和 Think 错误回退到 Anthropic
- 描述：向量模型 API Key 输入框未与普通模型对齐；切换厂商后缺少该厂商模型选项；Ollama 无法自动列出本机向量模型；部分老桌面配置只保存了普通模型到文件，Think 未读取该值而继续使用深度层默认 Opus，导致用户误以为必须配置 Anthropic Key。
- 根因：移除向量维度字段后布局仍保留四列；桌面端模型候选是固定的跨厂商 datalist；未通过 Ollama `/api/tags` 获取本地模型；Think 的模型解析只读取数据库配置，未兼容老桌面文件中的 `chat_model`。
- 解决方案：普通模型和向量模型统一为厂商、模型名称、API Key 三列；模型候选按当前厂商加载并保留自定义输入，Ollama 向量模型优先读取本机 `/api/tags`，离线时显示明确提示和常用候选；保留并修正向量模型切换警告；Think 在数据库没有显式覆盖时兼容读取老桌面 `chat_model`，并将无可用模型提示改为厂商中立文案。
- 是否完成：是
- 最终结果：模型配置三列对齐，可在当前厂商内直接切换已支持模型；Ollama 在线时自动合并本机模型，离线时不阻塞配置；切换向量模型会提示重建文本向量但保留原始数据；老用户已配置的普通模型继续被 Think 使用，不再无故要求 Anthropic Key。

## 2026-07-10 CLI 与桌面模型清单统一维护

- 时间：2026-07-10
- 版本号：PMBrain 1.0.90；Desktop 1.0.52
- 标题：修复桌面模型下拉与 CLI recipe 重复维护导致的模型漂移
- 描述：桌面端新增厂商模型下拉时另建了一份静态云模型清单，与 CLI 使用的 `src/core/ai/recipes` 分离；两份清单会出现名称、排序和新安装默认模型不一致，后续更新任意一处都可能再次产生漂移。
- 根因：桌面主进程独立维护 `CATALOG`，配置管理器还重复写死新安装默认模型，没有复用既有 recipe 注册表这一唯一模型能力来源。
- 解决方案：删除桌面云模型静态清单，桌面下拉通过 `getRecipe()` 直接读取 CLI recipe 的 chat/embedding 模型；新安装默认模型同样从 recipe 第一项生成。结合当前清单和官方生命周期信息，移除已明确即将停用的 DeepSeek 旧名称并更新 Google 当前型号；老用户显式保存的旧模型仍由 extended-model 机制兼容，不执行配置迁移或覆盖。
- 是否完成：是
- 最终结果：CLI、桌面下拉和新安装默认模型只维护一份 recipe 清单；Ollama 仍在该清单基础上动态合并本机 `/api/tags` 结果。相关桌面、网关、Think 与向量维度回归测试通过，未改变用户知识库数据。

## 2026-07-10 Admin 自然语言长文本解析与完整保存提示

- 时间：2026-07-10
- 版本号：PMBrain 1.0.91
- 标题：修复自然语言任务长文本导致模型 JSON 截断及界面误认为导入不完整
- 描述：用户粘贴长文并要求存入知识库时，模型会把全文重复写入 JSON，输出达到 token 上限后缺少闭合符号，Admin 直接显示英文解析错误；预览和执行结果仅展示摘要但未说明完整正文仍会保存，容易被误解为内容被截断。
- 根因：任务规划提示要求 `capture_memory` 返回完整 `content`，模型输出上限为 700 token；发送给模型的输入又只取前 4000 字，长文末尾的保存指令可能丢失。界面没有输入字数上限、计数器和摘要性质说明。
- 解决方案：模型只识别任务意图，不再回传长文；后端从用户输入中保留完整正文，并兼容 `capture_memo` 和被截断的 capture JSON。模型识别采用首尾片段以保留末尾指令，前后端统一限制为 10,000 字，超限时明确阻止发送且不静默截断；预览和完成结果标注完整字数及“页面仅显示摘要”。
- 是否完成：是
- 最终结果：长文本保存不再依赖模型完整复述正文，模型 JSON 被截断时也能安全恢复 capture 意图；用户能在发送前看到字数限制，发送后明确知道完整正文或导入范围未被界面摘要截断。

## 2026-07-10 GitHub Actions 多项 CI 失败修复

- 时间：2026-07-10
- 版本号：PMBrain 1.0.92
- 标题：修复 Test、Heavy Tests、Skill resolver 与生成文件校验失败
- 描述：GitHub Actions 中存在 PMBrain 改名后的旧断言、Skill 路由歧义、迁移 dry-run 产生副作用、测试隔离遗漏、Heavy Tests 初始化方式错误，以及 Windows/Linux 行尾导致的 llms 生成文件漂移。
- 根因：部分测试仍按 GBrain 旧品牌与旧阶段数量断言；新增 Skill 缺少完整契约和歧义标注；迁移 dry-run 仍进入数据库初始化；Heavy Tests 使用诊断命令代替数据库迁移；生成器直接拼接平台原始行尾；已被模型配置引用的 embedding 维度对齐模块未纳入提交。
- 解决方案：同步 PMBrain 契约与测试预期，补齐 Skill 元数据和 resolver 歧义，隔离串行测试，保证迁移 dry-run 无副作用，修正 Heavy Tests 初始化和日志保留，统一 llms 输入行尾，补齐 embedding 维度对齐模块、Admin 嵌入资产及回归测试，并将 Admin 路由测试改为整组复用一次冷启动服务。
- 是否完成：是
- 最终结果：严格 resolver 通过；Skill 合规测试 264 项通过；CI 相关组合测试通过，迁移、品牌契约、OAuth、公开导出、阶段覆盖、Admin 意图和生成文件均有回归验证。Heavy Tests 的数据库初始化失败根因已修正，等待 GitHub Actions 在 Linux/Postgres 环境复验。
## 2026-07-11 Dream 会议原子提取、模型配置漂移与日志品牌修复

- 时间：2026-07-11
- 版本号：PMBrain 1.0.94；Desktop 1.0.53
- 标题：修复会议整理缺少原子提取、错误使用陈旧模型及运行日志残留 GBrain 品牌
- 描述：Meeting Preset 已选择 `extract_atoms`，但通用 Schema Pack 门禁仍会跳过该阶段；桌面简单模式只同步 `models.default`，数据库中历史 `models.dream.*` 和 `models.tier.*` 覆盖继续优先生效；部分 CLI 与核心运行日志仍显示 GBrain 品牌。
- 根因：场景预设没有向统一 `runCycle()` 声明受信任的阶段强制项；桌面配置同步没有同时维护兼容键和清理用户明确切回简单模式时的高级覆盖；PMBrain 改名后的用户可见日志未完成集中复核。
- 解决方案：Meeting Preset 通过 `forcePackPhases` 仅绕过 `extract_atoms` 的 Pack 门禁，其他运行方式仍保持原门禁；桌面显式保存简单模式时清理 `models.tier.*`、`models.dream.*` 并同步 `chat_model` 与 `models.default`，升级迁移不删除高级配置；模型报告改用统一解析结果显示真实来源，并将运行期品牌日志与命令提示改为 PMBrain。
- 是否完成：是
- 最终结果：会议链路不再因活动 Pack 缺少声明而跳过 `extract_atoms`；当前数据库已清除陈旧模型覆盖并统一解析为 `deepseek:deepseek-v4-flash`；高级模式阶段覆盖优先级保持不变，用户可见运行日志不再沿用本次审计发现的 GBrain 前缀。

## 2026-07-12 桌面端安装包构建机路径泄漏

- 时间：2026-07-12
- 版本号：Desktop 1.0.55
- 标题：修复安装包校验发现预览文件携带本机路径
- 描述：桌面端打包时，`electron-builder` 通过 `out/**/*` 把预览脚本生成的 HTML 一并写入 `app.asar`；预览 HTML 含有本机示例路径，导致 `verify-package.ts` 报 `C:\Users\zhengyunhui` 泄漏并使 `build:win` 失败。
- 根因：生产输出目录与本地预览产物共用 `desktop/out/`，打包配置未限制生产文件范围。
- 解决方案：将 `electron-builder.yml` 的文件白名单收窄为 `out/main/**/*`、`out/preload/**/*` 和 `out/renderer/**/*`，保留预览脚本但不再把预览文件打进安装包；桌面版本递增到 1.0.55。
- 是否完成：是
- 最终结果：预览 HTML 不再进入 `app.asar`，构建机路径校验不会再被本地预览样例触发；最终 `bun run build:win` 仍由用户执行。

## 2026-07-12 GitHub Actions 失败项集中修复

- 时间：2026-07-12
- 版本号：PMBrain 1.1.4
- 标题：修复跨平台安装、Release 测试、Admin 依赖与多项回归断言失败
- 描述：Actions 中出现 Windows 安装阶段 POSIX 命令失败、Release Linux 直接执行未分片测试、Admin TSX 编译与依赖缺失、Linux 路径断言、Dream 标签、品牌断言、Federation embedding 维度以及 Heavy Tests 缺少 embedding 配置等问题。
- 根因：安装脚本依赖 Unix shell 语法；Release 使用了绕过项目测试脚本的命令；Admin 依赖未在 CI 中安装且根类型检查未配置 JSX；部分测试夹带平台、历史品牌和固定向量维度假设；Heavy Tests 未关闭 embedding。
- 解决方案：改用跨平台 Bun 安装脚本并保留失败时的提示；Release 统一使用 `bun run test` 并安装 Admin 依赖；Test/Release 工作流补齐 Admin 依赖和 JSX 类型检查；修正平台无关路径、当前品牌和 UI 标签断言；Federation fixture 不再硬编码 embedding 维度；Heavy Tests 使用 `--no-embed`。
- 是否完成：是
- 最终结果：本地定向测试、llms 生成校验和 postinstall 编译检查已通过；PR #4 的 Test、E2E、Admin 类型检查、10 个测试 shard、serial-tests 及手动 Heavy Tests 全部通过。Actions 的 Node.js 20 弃用提示为非阻断警告；最终 `bun run build:win` 仍由用户执行。
