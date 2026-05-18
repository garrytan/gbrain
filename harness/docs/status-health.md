---
title: 腦庫健康快照
type: status
tags: ["status", "health"]
source: agent
updated: 2026-05-19
---

# 腦庫健康快照

> 此頁為活文件。AI 每次回合開始時用 get_stats 更新數字。

## 最新數據

| 指標 | 數值 | 上次 | 趨勢 |
|------|------|------|------|
| Pages | 1661 | — | — |
| Links | 108 | — | ↑ |
| Timeline entries | 0 | — | — |
| Tags | 79 | — | — |
| Orphans | 待查 | — | — |
| 最後同步 | 2026-05-19 | — | — |

## 健康指標

| 項目 | 狀態 | 說明 |
|------|------|------|
| Link density | 🟡 低 | 108/1661 = 6.5%，目標 30%+ |
| Timeline coverage | 🔴 缺 | 0 條，待補充 |
| Orphan rate | ❓ 待查 | 執行 find_orphans 確認 |
| Tag coverage | 🟡 中 | 79 tags |

## 更新指令

```
# AI 回合開始時執行
GET /stats?otp=[TODAY_OTP]
→ 更新上表數字
→ 計算趨勢
→ 寫回此頁
```
