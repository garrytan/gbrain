---
title: "Enforcing Biome Rules"
type: note
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 69537ab1-aa2c-8331-b67c-819492359eb9
message_count: 2
tags: [chatgpt, import, code]
---
# Enforcing Biome Rules

> Conversation ID: 69537ab1-aa2c-8331-b67c-819492359eb9
> Created: 2025-12-30T07:09:48Z
> Updated: 2025-12-30T07:10:07Z
> Messages: 2

---

## User

Anything we should enforce in biome?

---

## Assistant

Yes, Mr. White — these are **high-leverage Biome rules worth enforcing** in most modern JS/TS repos. This assumes Biome is your **single formatter + linter** (no ESLint/Prettier overlap).

---

## **Must-Enforce (High Signal, Low Noise)**

### **Correctness**
- `noUnusedVariables`
- `noUnusedImports`
- `noImplicitAny` (TS)
- `noFallthroughSwitchClause`
- `useIsNan`
- `noCompareNegZero`

**Why:** Catches real bugs early. Zero downside.

---

### **Style (Consistency, Not Taste)**
- `useConst`
- `useSingleVarDeclarator`
- `noVar`
- `useTemplate`
- `useShorthandArrayType` (TS)
- `useShorthandObjectProperty`

**Why:** Cleaner diffs, predictable patterns.

---

### **Complexity / Maintainability**
- `noExcessiveCognitiveComplexity`
- `noNestedTernary`
- `noForEach` (prefer `map` / `reduce`)
- `noUselessCatch`
- `noEmptyBlockStatements`

**Why:** Prevents unreadable code before it ships.

---

### **Safety**
- `noDangerouslySetInnerHtml` (React)
- `noNonNullAssertion` (`!`)
- `noExplicitAny` (warn, not error)

**Why:** Forces intentional escape hatches.

---

## **Strongly Recommended (Depending on Team Size)**

### **Imports**
- `useImportType` (TS)
- `noDuplicateImports`
- `useSortedImports`

### **Async**
- `noAwaitInLoop`
- `requireAwait`

### **React**
- `useExhaustiveDependencies`
- `noArrayIndexKey`
- `noDirectMutationState`

---

## **Rules to Avoid (Low ROI / High Annoyance)**
- Line-length enforcement
- Enforced arrow vs function declarations
- Overly strict naming conventions
- Mandatory default exports

---

## **Baseline Biome Config (Opinionated, Safe)**
```json
{
  "linter": {
    "rules": {
      "recommended": true,
      "complexity": {
        "noExcessiveCognitiveComplexity": "warn"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true
  }
}
```

---

## **Bottom Line**
- Enforce **correctness + maintainability**
- Warn on **escape hatches**
- Let formatting be automatic
- Avoid stylistic bikeshedding

If you want, tell me:
- frontend vs backend
- React / Next / Node / monorepo
- team size

I’ll tighten this to a **production-grade config** in one pass.
