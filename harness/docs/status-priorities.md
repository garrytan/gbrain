---
title: 當前優先任務
type: task
tags: ["status", "priorities"]
source: agent
updated: 2026-05-19
---

# 當前優先任務

> 此頁為活文件。AI 每次回合結束後更新進度。

## 腦庫現況快照

| 指標 | 數值 | 目標 |
|------|------|------|
| Pages | 1661 | — |
| Links | 108 | 500+ |
| Timeline | 0 | 補充中 |
| Tags | 79 | — |
| Orphans | 待查 | 歸零 |

---

## P0 — 立即執行

- [x] 房多多主題建 link（108 條，已完成）
- [ ] 其他主題 link 建構（依密度排序）：
  1. AI 提示詞 / Meta-Structure
  2. 銷售劇本 / 黃執中
  3. 太空艙 / 未來智能（注意：兩個不同實體）
  4. LifeBuilder / 人生構築師
  5. 寫作 / 言靈
  6. 顯化
  7. 面試招募
  8. 興臺俱樂部（獨立主題，勿與房多多混）

## P1 — 本週

- [ ] 來源 tag 標記（source:original / source:external / source:mixed）

## P2 — 本月

- [ ] 時間線事件補充（頁面有明確日期時 add_timeline_entry）

## P3 — 持續

- [ ] 孤立頁面處理（find_orphans → wiki/index/{topic} → 批次建立 outbound links）

---

## 主題連結標準流程

0. `get_page("wiki/identity/distinct-entities")` ← 必讀
1. `search("主題A")` + `search("主題B")` 並行
2. 列出所有 slug，標注各自 namespace
3. `_root/` 或 `notes/` 路徑 → `get_page` 讀內容確認
4. 動手前告知 Ryan：分組方式、預計 link 數、中心頁面、排除頁面 + 理由
5. Ryan 確認後執行 `add_link`
6. 達到結束條件後回報

---

## 單次回合結束條件

達到任一即停止並回報：

- 已建立 50 條新 link
- 已標記 100 個 source tag
- 已完整處理 1 個主題
- 連續 5 次 search 沒找到可加工的頁面
- 累積 token 超過 50k

## 回報格式

```
本次回合結果：
- 處理主題：XXX
- 新增 links：N 條
- 排除頁面：slug + 排除理由
- 新增 wiki 頁面：slug 列表
- 剩餘待辦：下個建議主題
```
