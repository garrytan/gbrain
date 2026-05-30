---
name: 煉丹爐
version: 2.1.0
description: |
  元技能：把需求煉成符合 Azoth 標準的活 skill。
  融合 scaffold 架構分析（assets/scripts/refs 三問推理）與 Athanor 品質守門
  （邊界宣告、Nexus 四關、Azoth 三條件）。出爐的 skill 可觀測、有邊界、
  可回爐，並附帶配套的assets/scripts/refs 目錄與 azoth_certified 出爐標誌。
triggers:
  - "create a skill"
  - "new skill"
  - "improve this skill"
  - "建立 skill"
  - "新增 skill"
  - "幫我寫一個 skill"
  - "煉一個 skill"
  - "出爐"
  - "煉丹爐"
tools:
  - search
  - list_pages
  - put_page
mutating: true
---

# 煉丹爐 · Athanor

## Contract

- 每個出爐 skill 通過 Nexus 四關 + Azoth 三條件，才標記 `azoth_certified: true`
- 入口分叉：新建 skill vs 改造現有 skill 走不同路徑（Phase 入）
- 三節守門雙層（guard:content 確認內容實質 + guard:reachable 確認 SKILL.md 有索引指向）
- assets/scripts/refs 三資料夾由 Phase 3 推理後建立，目錄名**必須 ASCII**，sub-file 名稱描述內容
- SKILL.md 必須包含 `## On-Demand Index`，列明什麼情境載入哪個 sub-file
- Phase 0 歷史查詢防止重蹈失敗路徑
- 出爐 skill 有邊界宣告，mutable_layer < frozen_layer（層級順序強制）
- 出爐 skill 有 evolve 觸發條件，不靠外人觀察就知道何時需要重煉
- manifest.json 與 RESOLVER.md 更新才算出爐完成

---

## Phases

### Phase 入 — 判斷模式：新建 vs 改造

**目的：在開始前確認走哪條路，兩條路的起點不同。**

| 情境 | 判斷條件 | 路徑 |
|------|---------|------|
| **新建** | 沒有現有 skill 檔案 | Phase 0 → 1 → 2 → … |
| **改造** | 已有 SKILL.md，要升版或補齊結構 | 先讀原始檔 → Phase 入B → Phase 2 → … |

**改造路徑（Phase 入B）：**

1. 讀原始 SKILL.md 全文
2. 列出哪些內容**保留不動**（核心行為、已驗證的設計決策）
3. 列出**缺口清單**（缺哪些節、哪些 guard 沒過、哪些 Azoth 條件未滿足）
4. 確認改造範圍：只補缺口，不重寫已有效的部分
5. 從 Phase 2 繼續（邊界宣告通常已存在，確認即可）

改造不是重煉——不要把好的內容扔掉再重寫。

---

### Phase 0 — 讀玉簡歷史

**目的：不重蹈失敗路徑。**

```
search: "<skill 名稱> 失敗 deprecated"
search: "<skill 名稱> 過期 退回"
```

查詢：
- 同名或近似名稱的 skill 過去失敗原因
- 已棄用的提案與退回記錄
- 相關 audit log 裡 `was_overridden` 率高的 skill（可能有系統性問題）

若找到歷史記錄，在 Phase 1 明確說明「這次哪裡不同」。

---

### Phase 1 — 識別缺口 + MECE 檢查

**目的：確認這個 skill 有存在的理由。**

一句話描述需求：**「{動詞} {對象}，使得 {結果}。」**

MECE 檢查：
- 查 `skills/manifest.json` — 有沒有現有 skill 已覆蓋這個意圖？
- 查 `skills/RESOLVER.md` — trigger 是否與現有行重疊？
- 若重疊 → **擴充現有 skill**，不新建
- 若有 80% 重疊 → 考慮合併，明確說明差異後再決定

---

### Phase 2 — 確認需求與邊界宣告

**目的：在動筆前鎖定邊界，決定哪層可自動改、哪層要人工確認。**

與需求方確認：
1. 這個 skill 的核心 I/O contract 是什麼？
2. 哪些行為是固定的（frozen_layer），哪些可調（mutable_layer）？
3. 是否有外部依賴（API、工具、憑證）？
4. **執行環境是什麼？** agent 能主動用 Read 工具載入 sub-files 嗎？
   - `lbnumen`（Python executor）→ `skill_load()` 可主動載入任意路徑
   - `claude-code`（Claude Code skill 系統）→ 只有 SKILL.md 自動載入，sub-files 需 agent 主動 Read
   - 其他環境 → 確認後填入
   環境影響 Phase 4 的 On-Demand Index 寫法：`claude-code` 環境必須在 SKILL.md 裡明確指示 agent 何時用 Read 工具取哪個 sub-file。

**邊界宣告規則：**

```yaml
boundary_type: params | prompt | code | hybrid
mutable_layer: params | prompt    # 煉丹爐可自動修改
frozen_layer:  prompt | code      # 必須人工確認
```

層級順序：`params < prompt < code`
規則：`mutable_layer` **不得高於或等於** `frozen_layer`

違反層級 → 退回，不繼續。

---

### Phase 3 — 架構分析：資產 / 腳本 / 參考 三問

**目的：在建立目錄前，先推理每個資料夾應該裝什麼。**
空殼佔位符不算通過。答案要具體到「這個 skill」。

#### 問一：資產 — 「好的輸出長什麼樣？」

思考：
- 這個 skill 的典型輸出是什麼形狀？（頁面、報告、腳本輸出、圖表）
- 有沒有 before/after 能幫下一個 agent 校準品質？
- 有沒有模板、範例 payload 能示範 contract？

寫下：
1. **輸出形狀** — 帶標註的完整範例（不是「見範例」，是真正的範例）
2. **品質標準** — 3–5 條 agent 可自查的 checklist
3. **反例** — 低品質輸出的樣子 + 為什麼它失敗

#### 問二：腳本 — 「哪些重複工作可以自動化？」

思考：
- 這個 skill 有沒有檔案操作、批次處理、API 呼叫會重複執行？
- 有沒有 setup 步驟（安裝、auth、路徑檢查）可以腳本化？
- 有沒有驗證步驟（lint、測試、守門）應該由腳本負責？

寫下：
1. **腳本清單** — 每個腳本一行描述，標記 `[PRIMARY]`
2. **可貼入的用法** — paste-ready shell 指令加常用 flags
3. **依賴** — 工具、env var、憑證

若腳本 < 40 行且邏輯直接，現在就生成 `.sh/.py/.ts`，不只是文件。

#### 問三：參考 — 「哪些知識讓這個 skill 更準確？」

思考：
- 這個 skill 與哪些現有 skill 有依賴或串接關係？
- 有沒有外部文件、API 規格、標準這個 skill 的決策依賴？
- `skills/conventions/` 有哪些適用？

寫下：
1. **Skill 依賴表** — 關係用 `calls →` / `called by ←` / `chains ↔`
2. **外部參考** — URL 或路徑 + 一行說明為何重要
3. **適用 conventions** — 哪個 convention 檔案，什麼時候適用

---

### Phase 4 — 草擬 SKILL.md

**目的：建立符合 Azoth 標準的 skill 文件。**

使用此 frontmatter 模板：

```yaml
---
name: {kebab-case，唯一}
version: 1.0.0
description: |
  {觸發情境 + 做什麼 + 輸出什麼，一段話}
triggers:
  - "{trigger 1}"
  - "{trigger 2}"
tools:
  - {tool1}
boundary_type: params | prompt | code | hybrid
mutable_layer: params | prompt
frozen_layer:  prompt | code
azoth_certified: false
evolve:
  quantitative:
    window_days: 30
    success_threshold: 0.80
    override_threshold: 0.30
  event:
    consecutive_guard_failures: 3
  staleness:
    staleness_days: 90
mutating: {true|false}
---
```

**SKILL.md 必要五節：**
```
## Contract
## Phases
## On-Demand Index
## Output Format
## Anti-Patterns
## Tools Used
```

**`## On-Demand Index` 必須包含：**

```markdown
## On-Demand Index

按需載入——不要預先讀，遇到對應情境時用 Read 工具取得：

| 檔案 | 載入時機 |
|------|---------|
| `assets/{descriptive-name}.md` | {具體觸發情境，e.g. 需要示範完整輸出範例} |
| `refs/{descriptive-name}.md`   | {具體觸發情境，e.g. 搜尋外部案例來源時} |
```

規則：
- 檔案名稱必須描述內容（`examples.md`、`sources.md`），不用 `README.md`
- 每個 sub-file 的觸發情境要具體，不能寫「需要時」
- 如果 sub-file 的內容已完整內聯在 SKILL.md 裡，就不需要在 Index 裡列它

**SKILL.md 必要三節（供 Phase 5 守門用）：**
```
## 資產
## 腳本
## 參考
```

`## 資產`：列出依賴或產出的持久性物件，每條含名稱 + 存放位置。
`## 腳本`：列出可重複執行的流程，每個腳本含輸入/步驟/檢核點。
`## 參考`：列出書籍或 URL，至少一條有效來源。

---

### Phase 5 — 建立三資料夾 + 守門

**目的：讓配套目錄存在且有實質內容，再進入品質守門。**

**硬規則：目錄名和 sub-file 名必須全 ASCII。** 中文字元在 shell、CI、部分工具鏈會出問題。
- 目錄：`assets/`、`scripts/`、`refs/` — 固定，不得用中文
- Sub-file：用描述性英文名，不用 `README.md`（例：`examples.md`、`sources.md`、`cases.md`）

建立目錄結構：

```
skills/{name}/
├── SKILL.md
├── assets/
│   └── {examples|output|cases}.md   ← 描述性檔名
├── scripts/
│   ├── {scripts-index}.md
│   └── {script}.*                   ← 如 Phase 3 決定要生成
└── refs/
    └── {sources|references}.md      ← 描述性檔名
```

快速 scaffold（產生佔位檔，**必須在完成前改成描述性檔名**）：
```bash
bash skills/煉丹爐/scripts/scaffold.sh {name}
```

**守門雙層（兩層都要過，缺一退回 Phase 4）：**

```
─── Layer 1: guard:content（內容實質）───────────────────────────────
guard:assets   → assets/{file}.md 存在，含真實輸出範例（非純模板佔位）
guard:refs     → refs/{file}.md 存在，至少一條有效來源（URL 或具體路徑）
guard:scripts  → scripts/{file}.md 存在，至少一個腳本有輸入/步驟/檢核點

─── Layer 2: guard:reachable（執行可及）────────────────────────────
guard:index    → SKILL.md 包含 ## On-Demand Index 節
guard:routes   → Index 裡每個 sub-file 有明確觸發情境（不能寫「需要時」）
guard:ascii    → 所有目錄名和 sub-file 名為純 ASCII
```

驗證指令：
```bash
bash skills/煉丹爐/scripts/verify.sh {name}
```

---

### Phase 6 — Nexus 四關

**目的：品質守門，確保 skill 格式正確、無歧義、契約可驗、無重疊。**

```
guard:specs     → SKILL.md 格式正確，frontmatter 欄位齊全，boundary 層級合法
guard:clarity   → description 無歧義，triggers 無重疊（MECE），Anti-Patterns 存在
guard:contracts → I/O contract 通過至少一個 Example 驗證（Phase 3 推理 → 實際跑）
guard:cross     → 與現有 skill 無功能重疊（Phase 1 已查，此處最終確認）
```

任一關失敗 → 標記失敗關名，退回對應 Phase，寫入失敗記錄：

```
wiki/azoth/failures/{name}/{date} — {guard} 失敗原因
```

---

### Phase 7 — 寫入玉簡 + 更新 manifest / RESOLVER

**目的：讓 skill 對外可見、可路由、可查。**

1. **寫入玉簡：**
   ```
   wiki/azoth/skills/{name} — SKILL.md 內容快照
   ```

2. **寫 Athanor audit log：**
   ```
   wiki/azoth/audit/{date}/{name} — {phase0 歷史摘要 | 邊界宣告 | 守門結果}
   ```

3. **更新 manifest.json：**
   ```json
   {
     "name": "{name}",
     "path": "{name}/SKILL.md",
     "description": "{one-line}"
   }
   ```

4. **更新 RESOLVER.md：** 在正確分類下加一行路由。

---

### Phase 8 — Azoth 三條件驗收 → 出爐

**目的：確認 skill 滿足活 skill 的三個核心條件，然後正式出爐。**

**條件一：可觀測（Audit Log）**

SKILL.md 的 Phases 中必須有 `skill_log()` 呼叫描述，記錄欄位：

```
skill_name, version, iteration, run_id, invoked_at,
input_hash, output_hash, tokens_in, tokens_out,
duration_ms, was_overridden, success
```

`was_overridden` 是核心欄位 — 用戶是否修改或拒絕輸出。缺少 → 退回。

**條件二：有邊界（Boundary Declaration）**

frontmatter 的 `boundary_type / mutable_layer / frozen_layer` 已填，且：
- `mutable_layer` < `frozen_layer`（層級順序合法）
- 人工確認閾值在 `boundary.spec.md` 範圍內

**條件三：可回爐（Evolve Trigger）**

frontmatter 的 `evolve` 欄位存在，三類觸發閾值皆填：
- `quantitative.success_threshold` / `override_threshold`
- `event.consecutive_guard_failures`
- `staleness.staleness_days`

**三條件全通過 → 設定出爐標誌：**

```yaml
azoth_certified: true
```

**自舉測試（可選，強烈建議首版後執行）：**

用煉丹爐自身重煉 v.next：若 eval 分數差距 < 5% → 達到穩態。

---

## On-Demand Index

按需載入——不要預先讀，遇到對應情境時用 Read 工具取得：

| 檔案 | 載入時機 |
|------|---------|
| `assets/examples.md` | 需要示範完整出爐 skill 範例，或校準 azoth_certified 品質標準時 |
| `refs/references.md` | 需要查閱 Azoth 三條件規格、活 skill 定義、或 Nexus 四關框架來源時 |

---

## Output Format

```
skills/{name}/
├── SKILL.md                        ← azoth_certified: true
├── assets/{examples|cases}.md      ← 描述性檔名，非 README.md
├── scripts/scripts-index.md + 實際腳本
└── refs/{sources|references}.md    ← 描述性檔名，非 README.md
```

加 manifest.json 一條、RESOLVER.md 一行。

完成後輸出摘要表：

| 項目 | 狀態 |
|------|------|
| Phase 0 歷史查詢 | ✅ / ⚠️ 有前例 / ➖ 無記錄 |
| MECE 通過 | ✅ |
| 邊界宣告合法 | ✅ |
| guard:assets | ✅ |
| guard:refs | ✅ |
| guard:scripts | ✅ |
| guard:index | ✅ |
| guard:routes | ✅ |
| guard:ascii | ✅ |
| guard:specs | ✅ |
| guard:clarity | ✅ |
| guard:contracts | ✅ |
| guard:cross | ✅ |
| Azoth 三條件 | ✅ |
| azoth_certified | ✅ true |
| manifest.json | ✅ |
| RESOLVER.md | ✅ |

---

## Anti-Patterns

- **跳過 Phase 入** — 改造既有 skill 卻走新建流程，把好的內容扔掉重寫
- **跳過 Phase 0** — 不查歷史就動筆，重蹈失敗路徑
- **空殼 assets/scripts/refs** — 複製模板不填內容，guard:content 形同虛設
- **有 sub-files 但沒有 On-Demand Index** — guard:content 過了，guard:reachable 沒過，執行時 agent 讀不到
- **On-Demand Index 觸發情境寫「需要時」** — 不夠具體，agent 不知道什麼時候該觸發
- **目錄或 sub-file 用中文命名** — shell/CI 工具鏈會出問題，一律 ASCII
- **sub-file 統一叫 README.md** — 沒有描述性，agent 無法從名稱判斷內容
- **boundary 層級倒置** — `mutable_layer >= frozen_layer`（e.g. mutable=code, frozen=prompt）
- **沒有 `was_overridden`** — audit log 缺核心欄位，可觀測性失效
- **省略 evolve** — skill 沒有回爐觸發條件，只能等腐爛
- **trigger 重疊** — 未做 MECE 就加 trigger，導致路由衝突
- **功能重疊就新建** — 應擴充現有 skill 的情況下硬開新 skill
- **把腳本塞進 SKILL.md** — 可執行邏輯屬於 `scripts/`，不屬於 SKILL.md 正文

---

## Tools Used

| 工具 | 用途 |
|------|------|
| `search` | Phase 0 歷史查詢；Phase 1 MECE 檢查 |
| `list_pages` | Phase 1 查現有 skill 清單 |
| `put_page` | Phase 7 寫入玉簡（azoth/skills + audit） |

---

## 資產

| 資產 | 存放位置 |
|------|---------|
| 出爐 skill 範例（azoth_certified: true） | `skills/煉丹爐/assets/examples.md` |
| 失敗退回記錄 | `wiki/azoth/failures/{name}/{date}` |
| Athanor audit log | `wiki/azoth/audit/{date}/{name}` |

---

## 腳本

| 腳本 | 說明 | 狀態 |
|------|------|------|
| `scaffold.sh` | 一行建立新 skill 目錄結構 | [PRIMARY] |
| `verify.sh` | 本地守門驗證（guard + conformance） | utility |

---

## 參考

| 來源 | 路徑 | 說明 |
|------|------|------|
| Azoth 三條件規格 | `wiki/concepts/大還丹` | 出爐標準完整規格 |
| 活 skill 概念 | `wiki/concepts/活skill` | 出爐物的定義 |
| 自循環機制 | `wiki/concepts/自循環` | 可回爐的詳細實作 |
| 守門框架 | `wiki/projects/lb-nexus` | Nexus 四關規格 |
| 失敗歷史存檔 | `wiki/azoth/failures/` | Phase 0 查詢來源 |
| Conformance test | `test/skills-conformance.test.ts` | 必要 section 規格 |
