---
title: Agent Manual — Link 規則
source: agent
tags: ["fact"]
---

# Link 規則

## Link Type 準則

| 類型 | 使用時機 |
|------|---------|
| `mentions` | A 文中提到 B（不確定時選這個）|
| `related_to` | A 和 B 同主題不同角度 |
| `part_of` | A 是 B 的子集 |
| `references` | A 引用了 B 的具體論點/數據 |
| `responds_to` | A 是對 B 的回應/反駁/延伸 |
| `founded` | 創立關係 |
| `works_at` | 任職關係 |
| `invested_in` | 投資關係 |
| `advises` | 顧問關係 |
| `attended` | 出席活動 |

## Namespace 判斷（建 link 前三問）

1. 這個 slug 的 namespace 是什麼？→ 對照 `wiki/identity/distinct-entities` 找預設歸屬
2. 有沒有「興臺」「興台」字眼？→ 有則禁止連到房多多
3. 有沒有跨 namespace 吸引力？→ 有則讀內文確認，不靠名稱猜

## 回合結束條件

達到任一即停止並回報：

- 已建立 50 條新 link
- 已標記 100 個 source tag
- 已完整處理 1 個主題
- 連續 5 次 search 沒找到可加工的頁面

## 回報格式

```
本次回合結果：
- 處理主題：XXX
- 新增 links：N 條
- 排除頁面：slug + 排除理由
- 新增 wiki 頁面：slug 列表
- 剩餘待辦：下個建議主題
```
