# 資產 — 煉丹爐

> 這裡存放「好的出爐 skill 長什麼樣」的具體證據。
> 下一個執行煉丹爐的 agent 靠這裡校準品質，不需要重新推理。

## 出爐 skill 的完整輸出形狀

一個通過 Azoth 三條件的活 skill，其 frontmatter 看起來像：

```yaml
---
name: example-skill
version: 1.0.0
description: |
  [觸發情境] 當 X 時。
  [做什麼] 執行 Y 步驟。
  [輸出什麼] 產出 Z。
triggers:
  - "example trigger"
tools:
  - search
  - put_page
boundary_type: prompt
mutable_layer: params
frozen_layer: prompt
azoth_certified: true
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
```

目錄結構：

```
skills/example-skill/
├── SKILL.md                   ← azoth_certified: true，含五節 + 三節
├── assets/
│   └── README.md              ← 輸出範例 + 品質標準 + 反例
├── scripts/
│   ├── README.md              ← 腳本清單 + 用法 + 依賴
│   └── run.sh                 ← 若有 PRIMARY 腳本就在這
└── refs/
    └── README.md              ← skill 依賴表 + 外部參考 + conventions
```

## 品質標準

出爐前可自查：

- [ ] `azoth_certified: true` 在 frontmatter
- [ ] `boundary_type / mutable_layer / frozen_layer` 皆填，且 mutable < frozen
- [ ] `evolve` 三類觸發閾值皆填（quantitative / event / staleness）
- [ ] SKILL.md 含必要五節：Contract / Phases / Output Format / Anti-Patterns / Tools Used
- [ ] SKILL.md 含必要三節：資產 / 腳本 / 參考（非空）
- [ ] `skills/{name}/assets/README.md` 含真實輸出範例（非模板佔位）
- [ ] `skills/{name}/scripts/README.md` 含至少一個腳本的輸入/步驟/檢核點
- [ ] `skills/{name}/refs/README.md` 含至少一條有效來源
- [ ] manifest.json 已加入
- [ ] RESOLVER.md 已加入正確分類

## 反例（這樣不算出爐）

**反例一：空殼資產**
```markdown
# 資產 — my-skill
> Add your examples here.
## Output Shape
TBD
```
失敗原因：guard:assets 守門會退回。「TBD」不是輸出範例。

**反例二：boundary 層級倒置**
```yaml
mutable_layer: code
frozen_layer: prompt
```
失敗原因：`code > prompt`，mutable 不得高於 frozen，guard:specs 退回。

**反例三：缺 `was_overridden`**

audit log 描述沒有 `was_overridden` 欄位。
失敗原因：可觀測性失效，Azoth 條件一不通過，azoth_certified 不得設為 true。
