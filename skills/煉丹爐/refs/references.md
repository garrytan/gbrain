# 參考 — 煉丹爐

> 煉丹爐的決策依賴這些知識。查詢來源要用這裡標示的路徑。

## Skill 依賴關係

| Skill | 關係 | 說明 |
|-------|------|------|
| `skills/testing/SKILL.md` | calls → | Phase 5 verify.sh 呼叫 conformance test |
| `skills/skillify/SKILL.md` | chains ↔ | Skillify 把原始功能送進煉丹爐精煉 |
| `skills/repo-architecture/SKILL.md` | consults → | 新 skill 目錄應放在哪 |
| `skills/brain-ops/SKILL.md` | uses → | Phase 0/7 讀寫玉簡的操作規範 |

## 玉簡知識頁

| 頁面 | 說明 |
|------|------|
| `wiki/concepts/大還丹` | Azoth 三條件完整規格（必讀，Phase 8 依據） |
| `wiki/concepts/活skill` | 出爐物的定義，和靜態 skill 的差異 |
| `wiki/concepts/自循環` | 可回爐機制（evolve 觸發）詳解 |
| `wiki/projects/lb-numen` | 靈機（Numen）架構，煉丹爐所在的執行層 |
| `wiki/projects/lb-nexus` | 律令守門框架，Nexus 四關規格 |
| `wiki/azoth/failures/` | Phase 0 查詢目標，歷史失敗記錄 |
| `wiki/azoth/skills/` | 已出爐 skill 的玉簡快照 |
| `wiki/azoth/audit/` | Athanor audit log 存檔 |

## 外部規格檔

| Spec | 路徑（LB-numen repo） | 說明 |
|------|----------------------|------|
| create.spec.md | `openspec/changes/azoth/specs/skill/create.spec.md` | 技能創建 I/O 契約 |
| log.spec.md | `openspec/changes/azoth/specs/skill/log.spec.md` | audit log schema，核心欄位 `was_overridden` |
| boundary.spec.md | `openspec/changes/azoth/specs/skill/boundary.spec.md` | 邊界聲明規則與人工審核閾值 |
| evolve.spec.md | `openspec/changes/azoth/specs/skill/evolve.spec.md` | 回爐觸發條件與 I/O |

## 適用 Conventions

| Convention | 檔案 | 何時適用 |
|-----------|------|---------|
| 品質標準 | `skills/conventions/quality.md` | 所有 put_page 寫入前 |
| Brain-first | `skills/conventions/brain-first.md` | Phase 0/1 查詢前，先查腦庫再查外部 |
| 輸出規則 | `skills/_output-rules.md` | 所有生成的 markdown 內容 |
| Conformance | `test/skills-conformance.test.ts` | 必要 section 清單的權威來源 |
