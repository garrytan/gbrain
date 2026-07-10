---
name: pm-task
description: 查询、创建和更新 PMBrain 项目任务页面。
triggers:
  - "任务"
  - "分配"
  - "创建任务"
  - "更新任务"
  - "task"
tools:
  - search
  - read
  - write
  - edit
---

# PM 任务管理

## 功能
查询、创建、更新项目任务。

## 执行步骤

### 查询任务
1. 解析用户查询条件（项目名、状态、负责人、优先级等）
2. 使用 search 工具搜索 type: task 的页面
3. 按条件过滤，返回匹配的任务列表

### 创建任务
1. 确认必填字段：title、status、priority、project
2. 可选字段：assignee、deadline、milestone
3. 使用 task.md 模板生成页面内容
4. 使用 write 工具创建文件

### 更新任务
1. 使用 search 找到目标任务
2. 使用 read 读取当前内容
3. 使用 edit 更新指定字段
4. 保持其他字段不变

## 字段说明
- status: todo / in_progress / done / blocked
- priority: low / medium / high / critical
- assignee: 负责人名称
- deadline: 截止日期（YYYY-MM-DD）
- project: 所属项目名称
- milestone: 关联里程碑名称

## Contract

- 查询前先读取现有任务，不覆盖未要求修改的字段。
- 创建和更新任务时保持 PMBrain 页面结构及知识链接完整。

## Anti-Patterns

- 不在目标任务不明确时猜测并修改任务。
- 不删除任务页面或批量覆盖知识库内容。

## Output Format

返回匹配任务列表，或说明已创建/更新的任务及变更字段。
