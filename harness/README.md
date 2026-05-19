# 靈機

> 靈機讀玉簡，遵律令，以煉丹之法鍛技。

**靈機**是建立在**玉簡**（GBrain 腦庫）之上的 Python LLM 執行層。
讀知識、遵法則、行任務。三者缺一不可。

---

## 四器對照

| 名號 | 意涵 | 實體 |
|------|------|------|
| **靈機** | 靈機一動，天機運轉 | 本 harness — 執行層 |
| **玉簡** | 道士記錄仙法的玉質竹簡 | GBrain 腦庫 — 知識層 |
| **律令** | 令行禁止，天條不可違 | 軍工級 contract pipeline |
| **煉丹** | 在丹爐裡提煉靈藥 | skill 鍛造流程 |

---

## 架構

```
Genspark（計畫者）          靈機（執行者）
      │                          │
      │   wiki/inbox/ 任務頁      │
      └──────────────────────────┘
                   │
           ┌───────▼────────┐
           │  玉簡（GBrain） │  ← 腦庫、wiki、記憶
           └────────────────┘
```

三個永不改變的核心：

| 檔案 | 職責 |
|------|------|
| `loop.py` | 聖環 — model ↔ tools，≤50 行，永不修改 |
| `store.py` | SQLite run/step/tool_call 帳本 |
| `llm.py` | Anthropic SDK 薄包裝 |

工具自動掃描註冊 — 在 `tools/` 放一個 `class MyTool(Tool)` 即可。

---

## 工具清單（18 件）

| 工具 | 用途 |
|------|------|
| `search_memory` | 混合搜尋玉簡 |
| `read_memory` | 讀取指定 slug 頁面 |
| `write_memory` | 寫入 / 更新頁面 |
| `list_pages` | 列出指定前綴的頁面 |
| `bash` | 執行 shell 指令 |
| `ask_human` | 暫停等候人工輸入 |
| `web_fetch` | HTTP 抓取 |
| `skill_load` | 按關鍵字載入煉丹技法 |
| `skill_list` | 列出所有可用技法 |
| `check_inbox` | 檢查 `wiki/inbox/` 待辦任務 |
| `get_links` | 取得頁面對外連結 |
| `get_backlinks` | 取得頁面反向連結 |
| `get_tags` | 取得頁面標籤 |
| `add_tag` | 為頁面加標籤 |
| `add_link` | 新增有類型的連結 |
| `add_timeline` | 新增時間軸條目 |
| `get_timeline` | 取得頁面時間軸 |
| `get_stats` | 腦庫統計快照 |

---

## 玉簡活文件（13 頁）

靈機在三個層面維護 GBrain 中的常駐頁面：

**操作手冊**（按需載入，只讀需要的）
- `wiki/agent-manual` — 索引 + 開工／收工三步
- `wiki/agent-manual/tools` — 工具參考
- `wiki/agent-manual/rules` — 寫入安全規則、命名空間表
- `wiki/agent-manual/genspark` — Genspark 協作協議
- `wiki/agent-manual/workflow` — 任務執行流程

**狀態文件**（每次收工更新）
- `wiki/status/session-log` — 工作日誌，最新在前
- `wiki/status/priorities` — P0–P3 任務、進度
- `wiki/status/health` — 腦庫統計趨勢
- `wiki/status/orphans` — 孤立頁面清單

**慣例文件**（極少改動）
- `wiki/conventions/namespace-rules` — 命名空間規則表
- `wiki/conventions/frontmatter` — 標準 YAML 格式
- `wiki/conventions/sync-architecture` — Obsidian 永遠贏
- `wiki/workflow/protocol` — Genspark ↔ 靈機協作協議

推送全部 13 頁：

```bash
GBRAIN_TOTP_SECRET=<secret> python3 scripts/push_manual.py
```

---

## Genspark ↔ 靈機協作

Genspark 計畫，靈機執行。透過 `wiki/inbox/` 傳遞任務：

```markdown
---
status: pending
assigned_to: local-ai
created_by: genspark
---
## Task
整理上週所有 wiki/fdd/leads 新增潛客...
```

靈機開工時自動巡查：

```python
check_inbox(assigned_to="local-ai", limit=5)
```

狀態機：`pending → in_progress → done → reviewed`

---

## 律令 — 軍工級合約流水線

每個新工具都必須過關：

```
SPEC → guard:specs → gen:contracts → guard:contracts → IMPL → guard:all
```

```bash
python3 openspec/scripts/guard_specs.py     # 格式驗證
python3 openspec/scripts/gen_contracts.py   # 重新產生合約
python3 openspec/scripts/guard_contracts.py # 合約 + 範例驗證
```

全部 0 failed = 完成。**永不跳過 guard。永不手動編輯 `*_contract.py`。**

煉丹技法詳見 `skills/python-military-grade.md`。

---

## 環境設定

```bash
cd harness
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...
export GBRAIN_BASE=https://brain.yourdomain.com
export GBRAIN_TOTP_SECRET=<your-secret>
```

OTP 每日輪換（HMAC-SHA256），工具每次呼叫自動產生，無需手動更新。

---

## 啟動靈機

```bash
cd harness
python cli.py "巡查收件匣，接下第一個待辦任務，完成後回報"
```

每次執行記錄在 `~/.gbrain/harness.db`：

```bash
python cli.py show <run_id>
```

---

## 煙霧測試

```bash
cd harness
python3 -c "
import sys; sys.path.insert(0, '.')
from tools import load_tools
tools = load_tools()
print('靈機工具清單:', sorted(tools.keys()))
"
```

預期：18 件工具。

```bash
python3 openspec/scripts/guard_specs.py
python3 openspec/scripts/gen_contracts.py
python3 openspec/scripts/guard_contracts.py
```

預期：三關全部 `N passed, 0 failed`。
