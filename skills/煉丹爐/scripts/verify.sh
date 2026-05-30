#!/usr/bin/env bash
# verify.sh — 驗證一個 skill 通過煉丹爐所有守門
# 用法: bash skills/煉丹爐/scripts/verify.sh <skill-name>
# 執行位置: repo root

set -euo pipefail

SKILL_NAME="${1:-}"
if [[ -z "$SKILL_NAME" ]]; then
  echo "用法: $0 <skill-name>" >&2
  exit 1
fi

SKILL_DIR="skills/$SKILL_NAME"
SKILL_FILE="$SKILL_DIR/SKILL.md"
PASS=true

echo "=== 煉丹爐守門驗證: $SKILL_NAME ==="
echo ""

# ── 目錄結構 ──────────────────────────────────────────
echo "[ 目錄結構 ]"
for dir in "assets" "scripts" "refs"; do
  if [[ -d "$SKILL_DIR/$dir" ]]; then
    echo "  ✅ $dir/"
  else
    echo "  ❌ $dir/ 不存在"
    PASS=false
  fi
done
echo ""

# ── guard:ascii — 目錄名和 sub-file 名全 ASCII ─────────
echo "[ guard:ascii ]"
ASCII_FAIL=false
# Check for non-ASCII chars in directory names under skill dir
while IFS= read -r -d '' path; do
  basename_only=$(basename "$path")
  byte_len=$(printf '%s' "$basename_only" | wc -c | tr -d ' ')
  char_len=$(printf '%s' "$basename_only" | LANG=en_US.UTF-8 wc -m | tr -d ' ')
  if [[ "$byte_len" -ne "$char_len" ]]; then
    echo "  ❌ 非 ASCII 路徑: $path"
    PASS=false
    ASCII_FAIL=true
  fi
done < <(find "$SKILL_DIR" -mindepth 1 -print0 2>/dev/null)
if [[ "$ASCII_FAIL" == false ]]; then
  echo "  ✅ 所有目錄名和檔名為純 ASCII"
fi
echo ""

# ── Layer 1: guard:content（內容實質）─────────────────
echo "[ Layer 1: guard:content ]"

# guard:assets — 找任何 .md 檔，確認非純模板
ASSETS_MD=$(find "$SKILL_DIR/assets" -name "*.md" 2>/dev/null | head -1)
if [[ -n "$ASSETS_MD" ]]; then
  TODO_COUNT=$(grep -c "^TODO" "$ASSETS_MD" 2>/dev/null || true)
  TOTAL_LINES=$(wc -l < "$ASSETS_MD")
  if [[ "$TODO_COUNT" -gt 3 ]] || [[ "$TOTAL_LINES" -lt 10 ]]; then
    echo "  ⚠️  guard:assets — $(basename "$ASSETS_MD") 可能仍是模板（TODO: $TODO_COUNT 處，$TOTAL_LINES 行）"
  else
    echo "  ✅ guard:assets ($(basename "$ASSETS_MD"))"
  fi
else
  echo "  ❌ guard:assets — assets/ 裡沒有 .md 檔"
  PASS=false
fi

# guard:refs — 找任何 .md 檔，確認含有效來源
REFS_MD=$(find "$SKILL_DIR/refs" -name "*.md" 2>/dev/null | head -1)
if [[ -n "$REFS_MD" ]]; then
  if grep -qE "(http|wiki/|skills/)" "$REFS_MD" 2>/dev/null; then
    echo "  ✅ guard:refs ($(basename "$REFS_MD"))"
  else
    echo "  ⚠️  guard:refs — $(basename "$REFS_MD") 未見有效來源（URL 或路徑）"
  fi
else
  echo "  ❌ guard:refs — refs/ 裡沒有 .md 檔"
  PASS=false
fi

# guard:scripts — 找任何 .md 檔，確認含腳本條目
SCRIPTS_MD=$(find "$SKILL_DIR/scripts" -name "*.md" 2>/dev/null | head -1)
if [[ -n "$SCRIPTS_MD" ]]; then
  if grep -qE "\.(sh|py|ts)" "$SCRIPTS_MD" 2>/dev/null; then
    echo "  ✅ guard:scripts ($(basename "$SCRIPTS_MD"))"
  else
    echo "  ⚠️  guard:scripts — $(basename "$SCRIPTS_MD") 未見腳本條目（.sh/.py/.ts）"
  fi
else
  echo "  ❌ guard:scripts — scripts/ 裡沒有 .md 檔"
  PASS=false
fi
echo ""

# ── Layer 2: guard:reachable（執行可及）───────────────
echo "[ Layer 2: guard:reachable ]"

# guard:index — SKILL.md 含 ## On-Demand Index
if grep -q "^## On-Demand Index$" "$SKILL_FILE" 2>/dev/null; then
  echo "  ✅ guard:index (## On-Demand Index 存在)"
else
  echo "  ❌ guard:index — SKILL.md 缺少 ## On-Demand Index"
  PASS=false
fi

# guard:routes — index 裡每個 sub-file 有具體觸發情境（不只是「需要時」）
# Use flag-based awk to extract On-Demand Index sections; filter out template placeholders
INDEX_SECTION=$(awk 'BEGIN{s=0} /^## On-Demand Index$/{s=1; next} /^## / && s{s=0} s' "$SKILL_FILE" 2>/dev/null || true)
# Only count real entries (exclude template placeholders containing { })
INDEX_ENTRIES=$(echo "$INDEX_SECTION" | grep "^| \`" | grep -vc "{" 2>/dev/null || true)
VAGUE_COUNT=$(echo "$INDEX_SECTION" | grep "^| \`" | grep -vc "{" | xargs -I{} echo {} || true)
# Count vague triggers only in real (non-placeholder) entries
VAGUE_COUNT=$(echo "$INDEX_SECTION" | grep "^| \`" | grep -v "{" | grep -c "需要時\|when needed\|if needed" 2>/dev/null || true)
if [[ "$INDEX_ENTRIES" -eq 0 ]]; then
  echo "  ⚠️  guard:routes — On-Demand Index 裡沒有 sub-file 條目（或全是模板佔位）"
elif [[ "$VAGUE_COUNT" -gt 0 ]]; then
  echo "  ⚠️  guard:routes — 有 $VAGUE_COUNT 個觸發情境可能太模糊（「需要時」等）"
else
  echo "  ✅ guard:routes ($INDEX_ENTRIES 個 sub-file 有觸發情境)"
fi
echo ""

# ── SKILL.md 必要五節 + On-Demand Index ───────────────
echo "[ guard:specs — SKILL.md 必要節 ]"
for section in "## Contract" "## Phases" "## On-Demand Index" "## Output Format" "## Anti-Patterns" "## Tools Used"; do
  if grep -qF "$section" "$SKILL_FILE" 2>/dev/null; then
    echo "  ✅ $section"
  else
    echo "  ❌ $section 缺少"
    PASS=false
  fi
done
echo ""

# ── SKILL.md 必要三節（資產/腳本/參考）────────────────
echo "[ guard:specs — 資產 / 腳本 / 參考 ]"
for section in "## 資產" "## 腳本" "## 參考"; do
  if grep -qF "$section" "$SKILL_FILE" 2>/dev/null; then
    echo "  ✅ $section"
  else
    echo "  ❌ $section 缺少"
    PASS=false
  fi
done
echo ""

# ── Azoth frontmatter ──────────────────────────────────
echo "[ guard:specs — Azoth frontmatter ]"
for field in "boundary_type" "mutable_layer" "frozen_layer" "azoth_certified" "evolve"; do
  if grep -q "^$field:" "$SKILL_FILE" 2>/dev/null; then
    echo "  ✅ $field"
  else
    echo "  ❌ $field 缺少"
    PASS=false
  fi
done
echo ""

# ── manifest + RESOLVER 可見性 ─────────────────────────
echo "[ 可見性 ]"
if grep -q "\"$SKILL_NAME\"" skills/manifest.json 2>/dev/null; then
  echo "  ✅ manifest.json"
else
  echo "  ⚠️  manifest.json — 尚未加入 $SKILL_NAME"
fi

if grep -q "$SKILL_NAME" skills/RESOLVER.md 2>/dev/null; then
  echo "  ✅ RESOLVER.md"
else
  echo "  ⚠️  RESOLVER.md — 尚未加入 $SKILL_NAME"
fi
echo ""

# ── 結果 ───────────────────────────────────────────────
if [[ "$PASS" == true ]]; then
  echo "✅ 結構守門通過。執行 conformance test..."
  echo ""
  bun test test/skills-conformance.test.ts 2>&1 | tail -5
else
  echo "❌ 守門未通過，請修正上述問題後重新執行。"
  exit 1
fi
