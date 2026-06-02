---
conversation_id: 6949f6dc-e6bc-832e-9f66-9dfee795b4f4
created: 2025-12-23
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: YC Startup Branch Setup
type: note
updated: 2025-12-23
---

# YC Startup Branch Setup

> Conversation ID: 6949f6dc-e6bc-832e-9f66-9dfee795b4f4
> Created: 2025-12-23T01:56:45Z
> Updated: 2025-12-23T02:04:16Z
> Messages: 2

---

## User

what si the proerp branch setup for a yc startup

---

## Assistant

Mr. White, here is the **standard, battle-tested Git branch setup for a Y Combinator–style startup**. This optimizes for speed, safety, and small teams.

---

## Core Branches (Minimal by Design)

### **`main`**
- **Always production-ready**
- Every commit here is deployable
- Protected branch (PRs required, CI must pass)
- Tagged releases (or auto-deploy on merge)

### **`develop`** *(optional but common)*
- Integration branch for upcoming release
- Slightly unstable, but tested
- Some YC teams skip this and merge directly to `main` once disciplined

> YC partners often say: *“One branch is fine until it hurts.”*  
> Early teams often start **without `develop`**.

---

## Working Branches (Short-Lived)

### **`feature/*`**
- One feature or task per branch
- Branched from `main` (or `develop`)
- Examples:
  - `feature/onboarding-v2`
  - `feature/stripe-webhooks`

### **`fix/*`**
- Non-urgent bug fixes
- Same flow as feature branches

### **`hotfix/*`**
- Production emergency
- Branched from `main`
- Merged back into `main` immediately after fix

---

## Typical YC-Grade Flow (Lean)

1. `feature/x` → opened as PR
2. CI runs (tests + lint)
3. 1 reviewer max (or self-merge if solo)
4. Merge to `main`
5. Auto-deploy to production

**No long-lived branches. No release branches. No ceremony.**

---

## When to Add More Structure (Later)

Only add complexity **after**:
- >5 engineers
- Slower deploys
- Multiple daily incidents

Then consider:
- Release branches
- Environment branches (`staging`)
- Cherry-picking hotfixes

---

## What YC Partners Actually Expect
entity["organization","Y Combinator","startup accelerator"] does **not** reward process maturity early. They reward:
- Fast iteration
- Frequent deploys
- Low rollback cost

**Simple branches + strong CI > complex GitFlow.**

---

If you want, I can:
- Recommend **exact branch protection rules**
- Share a **GitHub / GitLab config**
- Tailor this for **monorepo vs microservices**

Just say which.


**Topic:** [[chatgpt-clusters/business_startup]]
