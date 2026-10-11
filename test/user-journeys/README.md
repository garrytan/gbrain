# 核心用户路径 E2E

这里的测试不是检查源码里有没有某个字符串，而是启动真实 PMBrain Desktop、真实 Admin、真实 PGLite 和真实 MCP HTTP 入口，再按用户操作验证结果。

## 日常定向路径

GitHub CI 执行 `python test/user-journeys/core_journeys.py --packaged`，打出
`desktop/dist/win-unpacked/PMBrain.exe` 后再点真实界面。本地源码调试可以不带
`--packaged`。

`python test/user-journeys/core_journeys.py` 会执行：

1. 新用户首次启动，选择 PGLite，配置本机 OpenAI-compatible 测试模型并进入管理台。
2. 从管理台上传真实 Markdown 和动态生成的 PDF，确认导入完成且关键词搜索可见。
3. 把知识页移入回收站，再从回收站恢复。
4. 把向量模型从 8 维切到 12 维，确认配置、数据库维度调整和重新向量化完成。
5. 在管理台创建真实 MCP Key，再通过 `/mcp` 调用 `search` 找到刚导入的内容。
6. 关闭并重新启动当前 Desktop，确认同一 PGLite 数据仍可在管理台读取。

所有数据库、配置、测试文档、日志和失败截图都写入 Git 已忽略的 `备份/核心用户路径测试/runs/`。测试只设置独立 `PMBRAIN_HOME`，不得读取或修改真实用户数据库。

## 后台任务定向路径

`python test/user-journeys/background_tasks.py --runtime source --artifacts-dir 备份/task-acceptance/source-run`
启动真实 HTTP 服务及独立 PGLite，使用本地合成模型服务测试后台导入、Markdown/PDF/DOCX、快速维护、深度整理预览、取消、显式重试及重启持久化。慢向量请求期间同时验证知识读取、MCP 搜索和助手对话；浏览器打开最新任务中心并保存截图。

将 `source` 改为 `bundled` 可验证当前 `desktop/build/extraResources/pmbrain-runtime`；先运行 Admin 构建与 `desktop` 的 `build:sidecar`。需要 Python 的 Playwright、reportlab 及本机 Edge；`--no-browser` 仅跳过浏览器部分，不代表 UI 已验收。每次使用新的产物目录，不连接真实用户库或外部收费模型。

## 发布升级路径

`release_upgrade_journey.py` 只在发布后的 Windows runner 执行。它安装上一版真实 NSIS，使用旧版软件创建 PGLite 数据，再点击软件更新，让 `electron-updater` 从 GitHub Releases 下载新安装包、停止 sidecar、安装并重启，最后确认新版本管理台仍能看到旧数据。

这条路径依赖两个真实发布版本，不属于每次小改的日常测试，也不能用 `FakeUpdater` 结果代替。
