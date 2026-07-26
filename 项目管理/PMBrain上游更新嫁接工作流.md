# PMBrain 上游更新嫁接工作流

## 目标

把 GBrain 更新变成可重复审计、按能力嫁接、保留 PMBrain 心智的流程，而不是整仓合并。

## 固定边界

- PMBrain：`D:\cursor-claude\PMBrain`，唯一写入目标。
- GBrain：`D:\cursor-claude\gbrain`，只读参考仓库。
- 基线：`.upstream/gbrain-baseline.json`。
- 审计脚本：`scripts/audit-gbrain-upstream.ps1`。
- 禁止自动 merge、rebase、cherry-pick 和整文件覆盖 PMBrain 核心文件。

## 每轮流程

1. 在本地更新 `D:\cursor-claude\gbrain`，不改 PMBrain。
2. 运行只读审计：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-gbrain-upstream.ps1
   ```

3. 需要保存报告时显式指定输出：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-gbrain-upstream.ps1 `
     -OutputPath .\项目管理\上游审计\2026-07-25.md
   ```

4. 按能力分类：

   - A：独立纯函数或新文件，可复制后做 PMBrain 命名适配；
   - B：复用算法，加 PMBrain Engine/Source/模型 Adapter；
   - C：两边核心文件均已分叉，只手工移植最小 diff；
   - D：涉及底层数据模型、隐私或大范围产品能力，先评估、另立项。

5. 每个候选先记录：

   - 上游 commit；
   - 上游文件与 PMBrain 落点；
   - 用户价值与风险；
   - 是否影响 CLI/GUI/Admin/Desktop；
   - 是否需要迁移、配置默认值和老用户兼容；
   - 回归测试与回退方法。

6. 只在独立 `codex/` 分支实施。核心能力层先确认设计，Admin/桌面端只调用已有 CLI 能力。
7. 先跑定向测试，再跑 `bun run typecheck` 和仓库 verify；Windows 打包始终由用户执行 `bun run build:win`。
8. 审查完成后，人工把 `.upstream/gbrain-baseline.json` 的 `reviewed_head` 更新为已审查的上游 HEAD。

## PMBrain 心智转换

嫁接时保留上游底层逻辑，但对外统一成 PMBrain：

- 命令和提示优先使用 `pmbrain`；
- 保留 `PMBRAIN_*` 环境变量优先、`GBRAIN_*` 向后兼容；
- PGLite、Postgres、Source、多模型和 Windows 桌面端必须继续兼容；
- GUI 面向小白，CLI 面向高级用户；
- 默认不自动写用户知识库；高成本或实验能力默认关闭；
- 不覆盖 PMBrain 的中文界面、Admin Console、桌面端和模型路由。

## 完成标准

一次上游嫁接只有同时满足以下条件才算完成：

- 能追溯到具体上游 commit；
- diff 只包含该能力所需改动；
- 老用户数据无需重建，迁移可重复；
- PGLite 定向测试通过，Postgres 有接口/SQL 对等验证；
- 新配置有安全默认值；
- 台账和版本号已更新；
- 明确列出与原规划不一致或暂缓的能力。
