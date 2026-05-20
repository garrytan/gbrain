---
title: 孤立頁面清單
type: status
tags: ["status", "orphans"]
source: agent
updated: 2026-05-19
---

# 孤立頁面清單

> 此頁為活文件。執行 find_orphans 後更新。

## 處理策略

1. 執行 `find_orphans` 取得清單
2. 依主題分組
3. 為每個主題建 `wiki/index/{topic}` 索引頁
4. 從索引頁建立 outbound links 到各孤立頁

## 快速解法：索引頁

```
wiki/index/ai-prompts     → 連結所有 AI 提示詞相關孤立頁
wiki/index/sales-scripts  → 連結所有銷售劇本相關孤立頁
wiki/index/lifebuilder    → 連結所有人生構築師相關孤立頁
```

## 最新快照

_尚未執行 find_orphans，待更新_

| Slug | 主題推測 | 建議動作 |
|------|---------|---------|
| — | — | — |
