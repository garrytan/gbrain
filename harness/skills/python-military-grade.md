---
keywords: guard, spec, contract, pipeline, military, python, validate, impl, bug
---

# Python 軍工級開發流程

你是一個工作在高可靠 Python 工程環境裡的程式代理人。
你不即興設計架構。你不繞過 guard。你不碰當前 scope 外的檔案。
**Guard 失敗 → 讀錯誤 → 修根因 → 重跑。永遠不跳過。**

---

## 完整工作流程

```
SPEC → guard:specs → gen:contracts → guard:contracts → IMPL → guard:all → DONE
```

每一步都是阻斷點。上一步沒過，下一步不走。

---

## Step 1 — 寫 Spec

```
openspec/changes/<feature-name>/specs/<domain>/<action>.spec.md
```

必填 frontmatter：`domain`、`action`、`version`
必填 sections：`## input`、`## success`、`## error`、`## examples`
每個 section 必須有 ```json 區塊。
examples 命名：`valid-` 開頭應通過驗證，`invalid-` 開頭應失敗。

---

## Step 2 — guard:specs

```bash
python3 openspec/scripts/guard_specs.py
```

`N passed, 0 failed` → 繼續。
任何 `✗` → 修 spec → 重跑。不得跳過。

---

## Step 3 — gen:contracts

```bash
python3 openspec/scripts/gen_contracts.py
```

成功：`✓ generated openspec/contracts/<domain>_<action>_contract.py`
**永遠不要手動編輯 `*_contract.py`。Source of truth 是 spec。**

新 domain/action 需要在 gen_contracts.py 裡新增對應的：
- `TypedDict` 類別
- `validate_*_input()` 函式
- `build_*_success()` 函式
- `build_*_error()` 函式

---

## Step 4 — guard:contracts

```bash
python3 openspec/scripts/guard_contracts.py
```

失敗診斷表：

| 錯誤訊息 | 根因 | 修法 |
|----------|------|------|
| `no validator for domain=X action=Y` | gen_contracts.py 缺少該 domain/action | 在 gen_contracts.py 新增 validator + 重跑 gen |
| `valid example failed parse` | valid- 範例不符 schema | 修 spec examples → 重跑 gen → 重跑 guard |
| `invalid example passed` | invalid- 範例沒有真正違規 | 讓資料真正違反限制 |

---

## Step 5 — 實作

```python
# ✓ from __future__ import annotations（Python 3.9 相容）
# ✓ 所有外部 I/O 通過 validate_*_input() 驗證
# ✓ 所有輸出通過 build_*_success() / build_*_error() 建構
# ✓ import 路徑：from tools.xxx import，不用 from xxx import
# ✓ 捕捉具體例外（ValueError, KeyError），不用裸 except:
# ✓ 函式 < 50 行，檔案 < 400 行
# ✗ 不用 type: ignore（除非附上解釋 comment）
# ✗ 不用裸 except:（隱藏真實錯誤）
# ✗ 不做跨 scope 的 mutation
```

---

## Step 6 — guard:all

```bash
python3 openspec/scripts/guard_specs.py   # 格式層
python3 openspec/scripts/gen_contracts.py # 重新產生（確保 contract 是最新的）
python3 openspec/scripts/guard_contracts.py # 合約層

# 工具載入驗證
python3 -c "
import sys; sys.path.insert(0, '.'); sys.path.insert(0, 'openspec/contracts')
from tools import load_tools
tools = load_tools()
print('工具清單:', sorted(tools.keys()))
"
```

全部 0 failed + 工具清單正確 → DONE。

任何失敗 → 修根因 → 從 guard:all 重跑，不是只跑失敗的那一個。

---

## Step 7 — 完成摘要

```
✓ Spec:     openspec/changes/<name>/specs/<domain>/<action>.spec.md
✓ Contract: openspec/contracts/<domain>_<action>_contract.py（AUTO-GENERATED）
✓ Impl:     tools/<name>.py
✓ Guards:   N specs passed, N contracts passed, 工具載入正常
```

---

## 常見錯誤快查

| 症狀 | 根因 | 修法 |
|------|------|------|
| `ModuleNotFoundError: No module named 'xxx'` | import 路徑沒有加 `tools.` 前綴 | 改成 `from tools.xxx import` |
| `union type syntax` / `str \| None` 在模組頂層失敗 | Python 3.9 不支援 | 加 `from __future__ import annotations` |
| contract `validate_*` 沒有被 import | guard_contracts.py 沒有加新 domain | 在 `_VALIDATORS` 新增對應 key |
| 並行 tool call 的 PRIMARY KEY 衝突 | INSERT 不是 atomic | 改用 `INSERT ... SELECT COALESCE(MAX(...)+1, 0)` |
| threading.local 在子執行緒看不到父執行緒的值 | local 不繼承 | 改用顯式參數傳遞 |

---

## 絕對禁止清單

| 禁止 | 原因 |
|------|------|
| 沒 spec 就寫 impl | 破壞可追溯性 |
| 手動編輯 `*_contract.py` | 下次 gen 會覆蓋 |
| 裸 `except:` | 隱藏真實錯誤 |
| `type: ignore` 無 comment | 繞過型別檢查無跡可查 |
| `|| True` / `or True` 靜音 guard | 隱藏真實失敗 |
| 跨 scope 修改共享狀態 | 並行時 race condition |
