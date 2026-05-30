#!/usr/bin/env bash
# scaffold.sh — 建立新 skill 的目錄結構
# 用法: bash skills/煉丹爐/scripts/scaffold.sh <skill-name>
# 執行位置: repo root

set -euo pipefail

SKILL_NAME="${1:-}"
if [[ -z "$SKILL_NAME" ]]; then
  echo "用法: $0 <skill-name>" >&2
  exit 1
fi

SKILL_DIR="skills/$SKILL_NAME"

if [[ -d "$SKILL_DIR" ]]; then
  echo "ERROR: $SKILL_DIR 已存在，中止。" >&2
  exit 1
fi

mkdir -p "$SKILL_DIR/assets" "$SKILL_DIR/scripts" "$SKILL_DIR/refs"

# SKILL.md 骨架（含 Azoth frontmatter + On-Demand Index）
cat > "$SKILL_DIR/SKILL.md" <<EOF
---
name: $SKILL_NAME
version: 1.0.0
description: |
  TODO: 觸發情境 + 做什麼 + 輸出什麼
triggers:
  - "TODO trigger"
tools:
  - search
boundary_type: prompt
mutable_layer: params
frozen_layer: prompt
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
mutating: false
---

# $SKILL_NAME

## Contract

- TODO

## Phases

1. TODO

## On-Demand Index

按需載入——不要預先讀，遇到對應情境時用 Read 工具取得：

| 檔案 | 載入時機 |
|------|---------|
| \`assets/examples.md\` | TODO: 具體觸發情境（e.g. 需要示範完整輸出範例時）|
| \`refs/sources.md\`    | TODO: 具體觸發情境（e.g. 搜尋外部案例來源時）|

## Output Format

TODO

## Anti-Patterns

- TODO

## Tools Used

| 工具 | 用途 |
|------|------|
| \`search\` | TODO |

## 資產

| 資產 | 存放位置 |
|------|---------|
| 輸出範例 + 品質標準 | \`assets/examples.md\` |

## 腳本

| 腳本 | 說明 | 狀態 |
|------|------|------|
| TODO | TODO | [PRIMARY] |

## 參考

| 來源 | 路徑 | 說明 |
|------|------|------|
| TODO | TODO | TODO |
EOF

# assets/examples.md — 輸出範例 + 品質標準
cat > "$SKILL_DIR/assets/examples.md" <<EOF
# 輸出範例 — $SKILL_NAME

> 好的輸出長什麼樣？下一個 agent 靠這裡校準品質。
> 載入時機：需要示範完整輸出範例，或校準輸出品質時。

## 完整範例

TODO: 帶標註的完整輸出（不是「見範例」，是真正的範例）

## 品質標準

- [ ] TODO criterion 1
- [ ] TODO criterion 2
- [ ] TODO criterion 3

## 反例

TODO: 低品質輸出的樣子 + 為什麼它失敗
EOF

# scripts/scripts-index.md — 腳本清單
cat > "$SKILL_DIR/scripts/scripts-index.md" <<EOF
# 腳本清單 — $SKILL_NAME

> 把這個 skill 流程中的機械步驟自動化。

## 腳本清單

| 腳本 | 說明 | 狀態 |
|------|------|------|
| \`example.sh\` | TODO | [PRIMARY] |

## 用法

\`\`\`bash
bash skills/$SKILL_NAME/scripts/example.sh
\`\`\`

## 依賴

- **工具：** TODO
- **Env var：** TODO
EOF

# refs/sources.md — 外部來源 + 依賴關係
cat > "$SKILL_DIR/refs/sources.md" <<EOF
# 來源與參考 — $SKILL_NAME

> 讓這個 skill 做決定有依據的知識。
> 載入時機：搜尋外部案例或需要引用原始文本來源時。

## Skill 依賴關係

| Skill | 關係 | 說明 |
|-------|------|------|
| \`skills/{other}/SKILL.md\` | calls → | TODO |

## 外部參考

| 來源 | 路徑 / URL | 說明 |
|------|-----------|------|
| TODO | TODO | TODO |

## 適用 Conventions

| Convention | 檔案 | 何時適用 |
|-----------|------|---------|
| 品質標準 | \`skills/conventions/quality.md\` | 所有 brain 寫入前 |
| 輸出規則 | \`skills/_output-rules.md\` | 所有生成的 markdown |
EOF

echo "✅ 骨架建立完成: $SKILL_DIR"
echo "   ├── SKILL.md               ← Azoth frontmatter + On-Demand Index stub"
echo "   ├── assets/examples.md     ← 重新命名為描述性檔名（必要）"
echo "   ├── scripts/scripts-index.md"
echo "   └── refs/sources.md        ← 重新命名為描述性檔名（必要）"
echo ""
echo "下一步："
echo "  1. 把 assets/examples.md、refs/sources.md 改成描述該 skill 的名稱"
echo "  2. 更新 SKILL.md 裡 ## On-Demand Index 的觸發情境（不能寫「需要時」）"
echo "  3. 執行煉丹爐 Phase 3 架構分析，填入真實內容"
echo "  4. 跑 bash skills/煉丹爐/scripts/verify.sh $SKILL_NAME"
