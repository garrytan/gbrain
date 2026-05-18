---
title: Namespace 判斷規則
type: convention
tags: ["convention", "namespace"]
source: agent
---

# Namespace 判斷規則

## 核心原則

**namespace 共現 ≠ 主題相關**

建 link 前必讀 `wiki/identity/distinct-entities` 確認實體歸屬。

## Namespace 對照表

| Namespace | 內容性質 | 處理原則 |
|-----------|---------|---------|
| `wiki/analysis/` | AI 分析報告 | 預設 AI 產出 |
| `工作/房多多/` | 房多多工作 | 預設房多多主題群 |
| `房多多資料庫/` | 房多多資料 | 預設房多多主題群 |
| `desktop/工作_房多多/` | 房多多桌面備份 | 預設房多多主題群 |
| `房多多工作/` | 房多多工作 | 預設房多多主題群 |
| `未來智能太空艙/` | 學員獨立公司 | 房多多相關但非旗下 |
| `_root/` 含「店股東」 | 房多多直營店事務 | 連到房多多體系 |
| `_root/` 含「興臺/興台」 | 興臺俱樂部 | **禁止連到房多多** |
| `notes/` 含「實習店長」 | 房多多培訓職位 | 連到房多多體系 |
| `ｌｂlife_builder.../` | Ryan 個人 AI 專案 | 獨立，不連房多多 |
| `專案/` | 看內文 | 多為個人專案 |
| `notes/`、`_root/` 其他 | 雜物抽屜 | **必須讀內容才能判斷** |

## 易混淆實體

完整清單見 `wiki/identity/distinct-entities`

## 建 link 前快速三問

1. 這個 slug 的 namespace 是什麼？→ 對照上表找預設歸屬
2. 有沒有「興臺/興台」字眼？→ 有則禁止連到房多多
3. 有沒有跨 namespace 吸引力？→ 有則讀內文確認，不靠名稱猜
