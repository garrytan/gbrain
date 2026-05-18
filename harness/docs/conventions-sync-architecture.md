---
title: 同步架構說明
type: convention
tags: ["convention", "sync"]
source: agent
---

# 同步架構說明

## 資料流向

```
Obsidian vault（iCloud 本機）
    ↓ rsync + gbrain sync（每天 22:00 autopilot）
Railway Postgres（主資料庫 + 向量索引）← AI 唯一安全寫入點
    ↓ gbrain export（每天 23:00，下行到 Obsidian）
Obsidian wiki-from-ai/（唯讀回顧區）
```

## 衝突規則

**Obsidian 永遠贏。**

每天 22:00 rsync 會把 Obsidian 的內容覆蓋到 Railway。
如果 AI 寫入了 `notes/` 或 `obsidian/` 前綴，會在下次同步時被覆蓋消失。

## AI 安全寫入區

| 前綴 | 安全？ | 原因 |
|------|--------|------|
| `wiki/` | ✅ 安全 | AI 專屬寫入空間 |
| `mem/` | ✅ 安全 | AI 專屬記憶空間 |
| `notes/` | ❌ 危險 | rsync 會覆蓋 |
| `obsidian/` | ❌ 危險 | rsync 會覆蓋 |
| `_root/` | ❌ 危險 | rsync 會覆蓋 |

## 時間表

| 時間 | 事件 |
|------|------|
| 22:00 | Obsidian → Railway（上行同步）|
| 23:00 | Railway → Obsidian wiki-from-ai/（下行匯出）|
| 隨時 | AI 可讀取 Railway 所有內容 |
| 隨時 | AI 只寫入 wiki/ 和 mem/ |
